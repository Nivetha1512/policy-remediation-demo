import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { Agent, CursorAgentError, type Run } from "@cursor/sdk";

const repoRoot = process.cwd();

type PolicyResult = {
  deny?: unknown;
  pass?: unknown;
};

type RemediationFile = {
  path: string;
  contents: string;
};

type RemediationOutcome = {
  outcome: "remediation";
  violation: string;
  rootCause: string;
  filesExamined: string[];
  remediation: string;
  whyThisLocation: string;
  files: RemediationFile[];
};

type NoCodeFixOutcome = {
  outcome: "no_code_fix";
  violation: string;
  rootCause: string;
  reason: string;
  recommendedAction: string;
};

type InvestigatorOutcome = RemediationOutcome | NoCodeFixOutcome;

type PullRequestContext = {
  branchA: string;
  headSha: string;
  number: string;
  url: string;
};

function runningOnGitHubActions(): boolean {
  return process.env.GITHUB_ACTIONS === "true";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertLocalSdkBlocked(options: {
  cloud?: unknown;
  local?: unknown;
}): void {
  if (runningOnGitHubActions() && options.local !== undefined) {
    throw new Error(
      "local Cursor SDK runtime is not invoked on GitHub Actions",
    );
  }
}

async function waitForRun(
  run: Run,
  label: string,
): Promise<Awaited<ReturnType<Run["wait"]>>> {
  const tools: string[] = [];
  const stream = run.supports("stream")
    ? (async () => {
        for await (const event of run.stream()) {
          if (event.type !== "tool_call") {
            continue;
          }
          console.log(`${label} tool ${event.name} ${event.status}`);
          tools.push(`${event.name}:${event.status}`);
        }
      })().catch((error: unknown) => {
        console.log(`${label} stream ended: ${errorMessage(error)}`);
      })
    : Promise.resolve();
  const result = await run.wait();
  await stream;
  console.log(
    `${label} tools=${tools.length > 0 ? tools.join(",") : "(none)"}`,
  );
  return result;
}

function runGit(
  args: string[],
  options: { allowFailure?: boolean } = {},
): string {
  try {
    return execFileSync("git", args, {
      cwd: repoRoot,
      encoding: "utf8",
      env: process.env,
    }).trim();
  } catch (error) {
    if (options.allowFailure) {
      return "";
    }
    throw error;
  }
}

function readPolicyResult(): PolicyResult {
  const path = join(repoRoot, "artifacts", "policy-result.json");
  if (!existsSync(path)) {
    throw new Error("artifacts/policy-result.json is missing");
  }
  return JSON.parse(readFileSync(path, "utf8")) as PolicyResult;
}

function isOpaDenial(result: PolicyResult): boolean {
  return (
    result.pass === false &&
    Array.isArray(result.deny) &&
    result.deny.length > 0
  );
}

function changedPaths(): string[] {
  const outputs = [
    runGit(["diff", "--no-renames", "--name-only", "-z", "--"]),
    runGit(["diff", "--cached", "--no-renames", "--name-only", "-z", "--"]),
    runGit(["ls-files", "--others", "--exclude-standard", "-z"]),
  ];

  return [
    ...new Set(
      outputs.flatMap((output) => output.split("\0").filter(Boolean)),
    ),
  ].sort();
}

function isPermittedTerraformSource(path: string): boolean {
  if (
    path.startsWith("/") ||
    path.split("/").includes("..") ||
    !path.endsWith(".tf")
  ) {
    return false;
  }

  const absolutePath = join(repoRoot, path);
  return !existsSync(absolutePath) || !lstatSync(absolutePath).isSymbolicLink();
}

function comparablePath(path: string): string {
  return path
    .split("/")
    .filter((part) => part !== "." && part !== "")
    .join("/");
}

function denyMessages(result: PolicyResult): string[] {
  if (!Array.isArray(result.deny)) {
    return [];
  }
  return result.deny.filter((item): item is string => typeof item === "string");
}

function buildPrompt(denies: string[]): string {
  return [
    "Investigate the Terraform policy denial.",
    "",
    "The policy denial messages are:",
    ...denies.map((message) => `- ${message}`),
    "",
    "Follow AGENTS.md.",
    "",
    "Use the denial messages above as the plan/policy result context. Inspect any repository files needed for the investigation.",
    "",
    "Determine whether a safe compliant code remediation can be made using only the repository and available plan/policy context.",
    "",
    "If yes:",
    "- use Write or StrReplace to apply the smallest compliant Terraform .tf source change",
    "- put the same full file contents after the edit in files. contents is the complete file text, not a unified diff",
    "- you may run terraform fmt on files you change",
    "- minimize blast radius",
    "- do not modify policy",
    '- return outcome="remediation"',
    "",
    "Never invent identifiers, ARNs, key IDs, resource IDs, names, or other values that do not exist in the repository or provided inputs.",
    "If a safe compliant fix requires information or an external value that is not available, do not guess.",
    "",
    "If no safe code fix can be justified:",
    "- do not edit source files",
    '- return outcome="no_code_fix"',
    "- explain what information, exception, ownership decision, or external dependency is required",
    "- do not include a files field",
    "",
    "Do not open branches, pull requests, issues, or comments.",
    "Do not push to the developer branch or main.",
    "The remediation pull request OPA check is the validation, not this agent turn.",
    "",
    "After any required file edits, your final message must be only one JSON object, with no Markdown fence or other text, matching exactly one of these shapes:",
    "",
    '{"outcome":"remediation","violation":"...","rootCause":"...","filesExamined":["..."],"remediation":"...","whyThisLocation":"...","files":[{"path":"main.tf","contents":"..."}]}',
    "",
    "or",
    "",
    '{"outcome":"no_code_fix","violation":"...","rootCause":"...","reason":"...","recommendedAction":"..."}',
  ].join("\n");
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: string[],
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    throw new Error(
      `investigator result has invalid fields: ${actual.join(", ")}`,
    );
  }
}

function requireString(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string" || field.trim() === "") {
    throw new Error(`investigator result field "${key}" must be non-empty`);
  }
  return field.trim();
}

function parseRemediationFiles(value: unknown): RemediationFile[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(
      'investigator result field "files" must be a non-empty array',
    );
  }

  const seen = new Set<string>();
  return value.map((item) => {
    if (!isRecord(item)) {
      throw new Error(
        'investigator result field "files" entries must be objects',
      );
    }
    assertExactKeys(item, ["path", "contents"]);
    const path = requireString(item, "path");
    const contents = item.contents;
    if (typeof contents !== "string" || contents.trim() === "") {
      throw new Error(
        'investigator result field "files" contents must be non-empty',
      );
    }
    if (!isPermittedTerraformSource(path)) {
      throw new Error(
        `investigator remediation path is not permitted Terraform source: ${path}`,
      );
    }
    const key = comparablePath(path);
    if (seen.has(key)) {
      throw new Error(`investigator remediation path is duplicated: ${path}`);
    }
    seen.add(key);
    return { path, contents };
  });
}

function parseOutcome(text: string): InvestigatorOutcome {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/);
  const json = fenced?.[1] ?? trimmed;

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("investigator result is not a single valid JSON object");
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("investigator result must be a JSON object");
  }

  const value = parsed as Record<string, unknown>;
  if (value.outcome === "remediation") {
    assertExactKeys(value, [
      "outcome",
      "violation",
      "rootCause",
      "filesExamined",
      "remediation",
      "whyThisLocation",
      "files",
    ]);
    if (
      !Array.isArray(value.filesExamined) ||
      value.filesExamined.length === 0 ||
      !value.filesExamined.every(
        (item) => typeof item === "string" && item.trim() !== "",
      )
    ) {
      throw new Error(
        'investigator result field "filesExamined" must be a non-empty string array',
      );
    }
    return {
      outcome: "remediation",
      violation: requireString(value, "violation"),
      rootCause: requireString(value, "rootCause"),
      filesExamined: value.filesExamined.map((item) => (item as string).trim()),
      remediation: requireString(value, "remediation"),
      whyThisLocation: requireString(value, "whyThisLocation"),
      files: parseRemediationFiles(value.files),
    };
  }

  if (value.outcome === "no_code_fix") {
    assertExactKeys(value, [
      "outcome",
      "violation",
      "rootCause",
      "reason",
      "recommendedAction",
    ]);
    return {
      outcome: "no_code_fix",
      violation: requireString(value, "violation"),
      rootCause: requireString(value, "rootCause"),
      reason: requireString(value, "reason"),
      recommendedAction: requireString(value, "recommendedAction"),
    };
  }

  throw new Error(
    'investigator result outcome must be "remediation" or "no_code_fix"',
  );
}

function pullRequestContext(): PullRequestContext {
  const branchA = process.env.PR_HEAD_REF;
  const headSha = process.env.PR_HEAD_SHA;
  const number = process.env.PR_NUMBER;
  const url = process.env.PR_URL;
  const headRepository = process.env.PR_HEAD_REPOSITORY;
  const repository = process.env.GITHUB_REPOSITORY;

  if (
    !branchA ||
    !headSha ||
    !number ||
    !url ||
    !headRepository ||
    !repository
  ) {
    throw new Error("pull request context is incomplete");
  }
  if (headRepository !== repository) {
    throw new Error(
      "remediation branches cannot target a developer branch in a fork",
    );
  }
  return { branchA, headSha, number, url };
}

function runGh(args: string[]): string {
  return execFileSync("gh", args, {
    cwd: repoRoot,
    encoding: "utf8",
    env: process.env,
  }).trim();
}

function buildPrBody(outcome: RemediationOutcome): string {
  return [
    "## Violation",
    "",
    outcome.violation,
    "",
    "## Root cause",
    "",
    outcome.rootCause,
    "",
    "## Files examined",
    "",
    ...outcome.filesExamined.map((path) => `- \`${path}\``),
    "",
    "## Remediation",
    "",
    outcome.remediation,
    "",
    "## Why this location",
    "",
    outcome.whyThisLocation,
    "",
    "## Verification",
    "",
    "Pending CI / authoritative policy check",
  ].join("\n");
}

function remoteChangedPaths(base: string, target: string): string[] {
  const output = runGit([
    "diff",
    "--no-renames",
    "--name-only",
    "-z",
    base,
    target,
    "--",
  ]);
  return output.split("\0").filter(Boolean).sort();
}

function fetchCloudBranch(branch: string): string {
  runGit(["check-ref-format", `refs/heads/${branch}`]);
  runGit([
    "fetch",
    "origin",
    `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
  ]);
  return runGit(["rev-parse", `refs/remotes/origin/${branch}`]);
}

function verifyRemediationChanges(base: string, target: string): string[] {
  const paths = remoteChangedPaths(base, target);
  if (paths.length === 0) {
    throw new Error("investigator produced no Terraform remediation");
  }

  const blocked = paths.filter((path) => !isPermittedTerraformSource(path));
  if (blocked.length > 0) {
    throw new Error(
      `investigator changed blocked files; refusing remediation PR: ${blocked.join(", ")}`,
    );
  }
  const symlinks = paths.filter((path) =>
    runGit(["ls-tree", target, "--", path]).startsWith("120000 "),
  );
  if (symlinks.length > 0) {
    throw new Error(
      `investigator created symbolic links; refusing remediation PR: ${symlinks.join(", ")}`,
    );
  }
  return paths;
}

function remediationBranchName(): string {
  const runId = process.env.GITHUB_RUN_ID;
  const runAttempt = process.env.GITHUB_RUN_ATTEMPT ?? "1";
  if (!runId || !/^\d+$/.test(runId) || !/^\d+$/.test(runAttempt)) {
    throw new Error(
      "numeric GITHUB_RUN_ID and GITHUB_RUN_ATTEMPT are required",
    );
  }
  return `policy-remediation/${runId}-${runAttempt}`;
}

function githubRepository(): string {
  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository) {
    throw new Error("GITHUB_REPOSITORY is not set");
  }
  return repository;
}

function closePullRequest(prUrl: string): void {
  runGh(["pr", "close", prUrl, "--repo", githubRepository()]);
  console.log(`closed pull request ${prUrl}`);
}

function closePullRequestBestEffort(prUrl: string): void {
  try {
    closePullRequest(prUrl);
  } catch (error) {
    console.log(`failed to close ${prUrl}: ${errorMessage(error)}`);
  }
}

function assertDeveloperHeadUnchanged(context: PullRequestContext): void {
  const remoteHead = runGit([
    "ls-remote",
    "--heads",
    "origin",
    `refs/heads/${context.branchA}`,
  ])
    .split(/\s+/)
    .at(0);
  if (remoteHead !== context.headSha) {
    throw new Error(
      "developer branch advanced during investigation; refusing stale remediation PR",
    );
  }
}

function verifiedCloudCommit(
  context: PullRequestContext,
  branch: string,
): string {
  const cloudCommit = fetchCloudBranch(branch);
  if (
    runGit(["merge-base", context.headSha, cloudCommit]) !== context.headSha
  ) {
    throw new Error(
      "investigator branch is not based on the pull request head",
    );
  }
  verifyRemediationChanges(context.headSha, cloudCommit);
  return cloudCommit;
}

function pullRequestBase(prUrl: string): string {
  const raw = runGh([
    "pr",
    "view",
    prUrl,
    "--repo",
    githubRepository(),
    "--json",
    "baseRefName",
  ]);
  const parsed = JSON.parse(raw) as { baseRefName?: string };
  if (!parsed.baseRefName) {
    throw new Error(`could not read base branch for ${prUrl}`);
  }
  return parsed.baseRefName;
}

function editRemediationPullRequest(
  prUrl: string,
  outcome: RemediationOutcome,
  base?: string,
): void {
  const args = [
    "pr",
    "edit",
    prUrl,
    "--repo",
    githubRepository(),
    "--title",
    "Remediate Terraform policy denial",
    "--body",
    buildPrBody(outcome),
  ];
  if (base) {
    args.push("--base", base);
  }
  runGh(args);
}

function retargetAndKeepRemediationPr(
  outcome: RemediationOutcome,
  context: PullRequestContext,
  branch: string,
  prUrl: string,
): void {
  try {
    assertDeveloperHeadUnchanged(context);
    verifiedCloudCommit(context, branch);
  } catch (error) {
    closePullRequestBestEffort(prUrl);
    throw error;
  }

  const base = pullRequestBase(prUrl);
  if (base === context.branchA) {
    console.log(`keeping remediation PR base ${base}`);
    editRemediationPullRequest(prUrl, outcome);
  } else {
    console.log(
      `retargeting remediation PR base from ${base} to ${context.branchA}`,
    );
    editRemediationPullRequest(prUrl, outcome, context.branchA);
  }
  console.log(`remediation PR: ${prUrl}`);
}

function verifyWorkingTreeRemediation(files: RemediationFile[]): string[] {
  const allowed = new Set(files.map((file) => comparablePath(file.path)));
  const paths = changedPaths();
  if (paths.length === 0) {
    throw new Error("investigator produced no Terraform remediation");
  }
  const blocked = paths.filter((path) => !isPermittedTerraformSource(path));
  if (blocked.length > 0) {
    throw new Error(
      `investigator changed blocked files; refusing remediation PR: ${blocked.join(", ")}`,
    );
  }
  const unexpected = paths.filter((path) => !allowed.has(comparablePath(path)));
  if (unexpected.length > 0) {
    throw new Error(
      `investigator changed blocked files; refusing remediation PR: ${unexpected.join(", ")}`,
    );
  }
  return paths;
}

function writeRemediationFiles(files: RemediationFile[]): void {
  if (files.length === 0) {
    throw new Error(
      'investigator result field "files" must be a non-empty array',
    );
  }
  for (const file of files) {
    if (file.contents.trim() === "") {
      throw new Error(
        'investigator result field "files" contents must be non-empty',
      );
    }
    if (!isPermittedTerraformSource(file.path)) {
      throw new Error(
        `investigator remediation path is not permitted Terraform source: ${file.path}`,
      );
    }
    const absolutePath = join(repoRoot, file.path);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, file.contents);
    console.log(`wrote remediation file ${file.path}`);
  }
  execFileSync("terraform", ["fmt", "--", ...files.map((file) => file.path)], {
    cwd: repoRoot,
    stdio: "inherit",
    env: process.env,
  });
}

function createRemediationPrFromWorkingTree(
  outcome: RemediationOutcome,
  context: PullRequestContext,
): void {
  const branchB = remediationBranchName();

  runGh(["auth", "setup-git"]);
  assertDeveloperHeadUnchanged(context);
  if (runGit(["rev-parse", "HEAD"]) !== context.headSha) {
    throw new Error("checkout does not match the pull request head SHA");
  }
  closeCursorPullRequests(context);

  writeRemediationFiles(outcome.files);
  const remediations = verifyWorkingTreeRemediation(outcome.files);

  runGit(["checkout", "-b", branchB]);
  runGit(["add", "--", ...remediations]);
  execFileSync(
    "git",
    [
      "-c",
      "user.name=github-actions[bot]",
      "-c",
      "user.email=41898282+github-actions[bot]@users.noreply.github.com",
      "commit",
      "-m",
      "Remediate Terraform policy denial",
      "--",
      ...remediations,
    ],
    { cwd: repoRoot, stdio: "inherit", env: process.env },
  );
  runGit(["push", "-u", "origin", branchB]);

  const existing = openPullRequestsByHead().get(branchB);
  if (existing) {
    retargetAndKeepRemediationPr(outcome, context, branchB, existing);
    return;
  }

  assertDeveloperHeadUnchanged(context);
  verifiedCloudCommit(context, branchB);
  const prUrl = runGh([
    "pr",
    "create",
    "--repo",
    githubRepository(),
    "--head",
    branchB,
    "--base",
    context.branchA,
    "--title",
    "Remediate Terraform policy denial",
    "--body",
    buildPrBody(outcome),
  ]);
  console.log(`remediation PR: ${prUrl}`);
}

function openPullRequestsByHead(): Map<string, string> {
  const raw = runGh([
    "pr",
    "list",
    "--repo",
    githubRepository(),
    "--state",
    "open",
    "--limit",
    "100",
    "--json",
    "url,headRefName",
  ]);
  const prs = JSON.parse(raw) as Array<{ url: string; headRefName: string }>;
  return new Map(prs.map((pr) => [pr.headRefName, pr.url]));
}

function closeCursorPullRequests(context: PullRequestContext): void {
  for (const [branch, prUrl] of openPullRequestsByHead()) {
    if (!branch.startsWith("cursor/")) {
      continue;
    }
    try {
      const cloudCommit = fetchCloudBranch(branch);
      if (
        runGit(["merge-base", context.headSha, cloudCommit]) !==
        context.headSha
      ) {
        continue;
      }
    } catch (error) {
      console.log(
        `skipping cursor pull request ${branch}: ${errorMessage(error)}`,
      );
      continue;
    }
    closePullRequestBestEffort(prUrl);
  }
}

function createNoCodeFixIssue(
  outcome: NoCodeFixOutcome,
  context: PullRequestContext,
): void {
  runGh(["auth", "setup-git"]);
  closeCursorPullRequests(context);

  const changed = changedPaths();
  if (changed.length > 0) {
    throw new Error(
      `no_code_fix outcome changed files; refusing issue creation: ${changed.join(", ")}`,
    );
  }

  const issueBody = [
    "## Violation",
    "",
    outcome.violation,
    "",
    "## Root cause",
    "",
    outcome.rootCause,
    "",
    "## Why no safe code fix was generated",
    "",
    outcome.reason,
    "",
    "## Recommended action",
    "",
    outcome.recommendedAction,
    "",
    "## Originating pull request",
    "",
    context.url,
  ].join("\n");
  const issueUrl = runGh([
    "issue",
    "create",
    "--repo",
    githubRepository(),
    "--title",
    `Policy remediation requires human input: ${outcome.violation}`.slice(
      0,
      256,
    ),
    "--body",
    issueBody,
  ]);
  const issueNumber = issueUrl.split("/").at(-1);
  if (!issueNumber || !/^\d+$/.test(issueNumber)) {
    throw new Error(`could not determine issue number from ${issueUrl}`);
  }

  runGh([
    "pr",
    "comment",
    context.number,
    "--repo",
    githubRepository(),
    "--body",
    [
      "Policy remediation could not be safely generated.",
      "",
      `A follow-up issue has been created: #${issueNumber}`,
      "",
      "This pull request remains blocked by the failed policy check.",
    ].join("\n"),
  ]);
  console.log(`follow-up issue: ${issueUrl}`);
}

function hideGithubCredentials(): () => void {
  const saved = {
    GH_TOKEN: process.env.GH_TOKEN,
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
  };
  delete process.env.GH_TOKEN;
  delete process.env.GITHUB_TOKEN;
  return () => {
    if (saved.GH_TOKEN !== undefined) {
      process.env.GH_TOKEN = saved.GH_TOKEN;
    }
    if (saved.GITHUB_TOKEN !== undefined) {
      process.env.GITHUB_TOKEN = saved.GITHUB_TOKEN;
    }
  };
}

async function main(): Promise<void> {
  if (!process.env.CURSOR_API_KEY) {
    throw new Error("CURSOR_API_KEY is not set");
  }

  const policyResult = readPolicyResult();
  if (!isOpaDenial(policyResult)) {
    throw new Error("investigator requires an OPA policy denial");
  }

  if (!existsSync(join(repoRoot, "artifacts", "plan.json"))) {
    throw new Error("artifacts/plan.json is missing");
  }

  const context = pullRequestContext();
  if (runGit(["rev-parse", "HEAD"]) !== context.headSha) {
    throw new Error("checkout does not match the pull request head SHA");
  }
  if (changedPaths().length > 0) {
    throw new Error("working tree must be clean before investigation");
  }

  const initialHead = runGit(["rev-parse", "HEAD"]);
  const initialBranches = runGit([
    "for-each-ref",
    "--format=%(refname):%(objectname)",
    "refs/heads/",
  ]);
  const denies = denyMessages(policyResult);
  const prompt = buildPrompt(denies);

  let outcome: InvestigatorOutcome | undefined;
  const restoreGithubCredentials = hideGithubCredentials();
  try {
    const repository = process.env.GITHUB_REPOSITORY!;
    const server = process.env.GITHUB_SERVER_URL ?? "https://github.com";
    const agentOptions = {
      apiKey: process.env.CURSOR_API_KEY,
      model: { id: "composer-2.5" },
      cloud: {
        repos: [
          {
            url: `${server}/${repository}`,
            startingRef: context.headSha,
          },
        ],
        workOnCurrentBranch: false,
        autoCreatePR: false,
        skipReviewerRequest: true,
      },
    };
    assertLocalSdkBlocked(agentOptions);
    await using agent = await Agent.create(agentOptions);
    console.log(`agent.id=${agent.agentId}`);
    const run = await agent.send(prompt, { mode: "agent" });
    console.log(`run.id=${run.id}`);
    const result = await waitForRun(run, "investigate");
    console.log(`run.id=${result.id} status=${result.status}`);

    if (result.status === "error") {
      console.error(`run failed: ${result.id}`);
      if (result.error?.message) {
        console.error(result.error.message);
      }
      process.exitCode = 2;
      return;
    }

    if (result.status !== "finished") {
      console.error(`run did not finish: ${result.status}`);
      process.exitCode = 2;
      return;
    }

    outcome = parseOutcome(result.result ?? "");
  } catch (error) {
    if (error instanceof CursorAgentError) {
      console.error(
        `startup failed: ${error.message}, retryable=${error.isRetryable}`,
      );
      process.exitCode = 1;
      return;
    }
    throw error;
  } finally {
    restoreGithubCredentials();
  }

  if (process.exitCode) {
    return;
  }
  if (!outcome) {
    throw new Error("investigator did not return an outcome");
  }

  if (runGit(["rev-parse", "HEAD"]) !== initialHead) {
    throw new Error("investigator changed HEAD; refusing orchestration");
  }
  if (
    runGit([
      "for-each-ref",
      "--format=%(refname):%(objectname)",
      "refs/heads/",
    ]) !== initialBranches
  ) {
    throw new Error(
      "investigator created or changed a local branch; refusing orchestration",
    );
  }

  console.log(JSON.stringify(outcome, null, 2));
  if (outcome.outcome === "remediation") {
    createRemediationPrFromWorkingTree(outcome, context);
    return;
  }
  createNoCodeFixIssue(outcome, context);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});

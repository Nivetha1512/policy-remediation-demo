import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  Agent,
  CursorAgentError,
  JsonlLocalAgentStore,
  type Run,
  type SDKAgent,
  type SDKArtifact,
} from "@cursor/sdk";

const repoRoot = process.cwd();
const CLOUD_PERSIST_ATTEMPTS = 8;
const CLOUD_PERSIST_DELAY_MS = 5000;

type PolicyResult = {
  deny?: unknown;
  pass?: unknown;
};

type RemediationOutcome = {
  outcome: "remediation";
  violation: string;
  rootCause: string;
  filesExamined: string[];
  remediation: string;
  whyThisLocation: string;
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

type CloudBranch = {
  branch: string;
  prUrl?: string;
};

type CloudGit = {
  branches?: Array<{ branch?: string; prUrl?: string }>;
};

type TerraformArtifact = {
  path: string;
  contents: Buffer;
};

type CloudPersistResult = {
  branches: CloudBranch[];
  terraformFiles: TerraformArtifact[];
};

function runningOnGitHubActions(): boolean {
  return process.env.GITHUB_ACTIONS === "true";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(
  value: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const field = value[key];
    if (typeof field === "string" && field !== "") {
      return field;
    }
  }
  return undefined;
}

function workspaceTerraformPath(raw: string): string | undefined {
  let relative = raw.replace(/^\/+/, "");
  relative = relative.replace(/^workspace\//, "");
  if (relative.startsWith("artifacts/")) {
    relative = relative.slice("artifacts/".length);
  }
  relative = relative.replace(/^workspace\//, "");
  return isPermittedTerraformSource(relative) ? relative : undefined;
}

function mergeTerraformFiles(files: TerraformArtifact[]): TerraformArtifact[] {
  const byPath = new Map<string, Buffer>();
  for (const file of files) {
    byPath.set(file.path, file.contents);
  }
  return [...byPath.entries()].map(([path, contents]) => ({ path, contents }));
}

function unwrapToolRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    return {};
  }
  if (isRecord(value.success)) {
    return { ...value, ...value.success };
  }
  return value;
}

function captureTerraformFromTool(
  event: {
    name: string;
    args?: unknown;
    result?: unknown;
  },
  previous: Map<string, Buffer>,
): TerraformArtifact[] {
  const args = unwrapToolRecord(event.args);
  const result = unwrapToolRecord(event.result);
  const pathRaw =
    stringField(args, ["path", "file_path", "filePath"]) ??
    stringField(result, ["path", "file_path", "filePath"]);
  if (!pathRaw) {
    return [];
  }
  const path = workspaceTerraformPath(pathRaw);
  if (!path) {
    return [];
  }

  const fullText =
    stringField(result, [
      "afterFullFileContent",
      "fileContentAfterWrite",
      "streamContent",
      "contents",
      "content",
    ]) ??
    stringField(args, ["streamContent", "fileText", "contents", "content"]);
  if (typeof fullText === "string" && fullText.includes("\n")) {
    return [{ path, contents: Buffer.from(fullText) }];
  }

  const oldString = stringField(args, ["old_string", "oldString", "old_str"]);
  const newString = stringField(args, ["new_string", "newString", "new_str"]);
  if (oldString !== undefined && newString !== undefined) {
    const base = previous.get(path)
      ? previous.get(path)!.toString("utf8")
      : existsSync(join(repoRoot, path))
        ? readFileSync(join(repoRoot, path), "utf8")
        : undefined;
    if (base === undefined || !base.includes(oldString)) {
      console.log(`cloud edit old_string not found in ${path}`);
      return [];
    }
    return [
      { path, contents: Buffer.from(base.replace(oldString, newString)) },
    ];
  }

  return [];
}

async function waitForRun(
  run: Run,
  label: string,
): Promise<{
  result: Awaited<ReturnType<Run["wait"]>>;
  terraformFiles: TerraformArtifact[];
}> {
  const tools: string[] = [];
  const captured = new Map<string, Buffer>();
  const stream = run.supports("stream")
    ? (async () => {
        for await (const event of run.stream()) {
          if (event.type !== "tool_call") {
            continue;
          }
          console.log(`${label} tool ${event.name} ${event.status}`);
          tools.push(`${event.name}:${event.status}`);
          if (
            /edit|write|replace/i.test(event.name) &&
            (event.status === "completed" || event.status === "running")
          ) {
            console.log(
              `${label} ${event.name} args=${JSON.stringify(event.args ?? null).slice(0, 4000)}`,
            );
            if (event.result !== undefined) {
              console.log(
                `${label} ${event.name} result=${JSON.stringify(event.result).slice(0, 4000)}`,
              );
            }
            for (const file of captureTerraformFromTool(event, captured)) {
              captured.set(file.path, file.contents);
              console.log(`captured cloud terraform edit ${file.path}`);
            }
          }
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
  return {
    result,
    terraformFiles: [...captured.entries()].map(([path, contents]) => ({
      path,
      contents,
    })),
  };
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
    ...new Set(outputs.flatMap((output) => output.split("\0").filter(Boolean))),
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
    "- use file edit tools (Write or StrReplace) to apply the smallest compliant Terraform .tf source change",
    "- copy each changed .tf file into artifacts/ using the same repository-relative path",
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
    "",
    "When the platform provides a remediation branch or workspace, make changes only there.",
    "Never push changes to the developer branch or main.",
    "Do not create GitHub issues or post GitHub comments. Deterministic orchestration handles those operations.",
    "Do not create additional branches or pull requests outside the platform-provided remediation flow.",
    "",
    "After any required file edits, your final message must be only one JSON object, with no Markdown fence or other text, matching exactly one of these shapes:",
    "",
    '{"outcome":"remediation","violation":"...","rootCause":"...","filesExamined":["..."],"remediation":"...","whyThisLocation":"..."}',
    "",
    "or",
    "",
    '{"outcome":"no_code_fix","violation":"...","rootCause":"...","reason":"...","recommendedAction":"..."}',
  ].join("\n");
}

function buildPersistPrompt(): string {
  return [
    "The previous turn identified a safe Terraform remediation, but Cursor did not persist a named git branch or artifacts.",
    "A JSON-only reply is not enough.",
    "You must use file edit tools this turn before you answer:",
    "1. Re-apply the same smallest compliant Terraform .tf source change with Write or StrReplace, even if you believe it is already saved.",
    "2. Copy each changed .tf file into artifacts/<repository-relative-path> so orchestration can download it.",
    "",
    "Do not change the remediation, do not edit policy, and do not edit non-.tf files.",
    "Do not invent a new fix or choose a different location.",
    "Never invent identifiers, ARNs, key IDs, resource IDs, names, or other values that do not exist in the repository or provided inputs.",
    "When the platform provides a remediation branch or workspace, make changes only there.",
    "Never push changes to the developer branch or main.",
    "Do not create GitHub issues or post GitHub comments. Deterministic orchestration handles those operations.",
    "Do not create additional branches or pull requests outside the platform-provided remediation flow.",
    "",
    "After those tool calls, your final message must be the same JSON outcome object as before, with no Markdown fence.",
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
  cloud: CloudBranch,
): void {
  if (!cloud.prUrl) {
    throw new Error("auto-created remediation pull request URL is missing");
  }

  runGh(["auth", "setup-git"]);
  try {
    assertDeveloperHeadUnchanged(context);
    verifiedCloudCommit(context, cloud.branch);
  } catch (error) {
    closePullRequestBestEffort(cloud.prUrl);
    throw error;
  }

  const base = pullRequestBase(cloud.prUrl);
  if (base === context.branchA) {
    console.log(`keeping remediation PR base ${base}`);
    editRemediationPullRequest(cloud.prUrl, outcome);
  } else {
    console.log(
      `retargeting remediation PR base from ${base} to ${context.branchA}`,
    );
    editRemediationPullRequest(cloud.prUrl, outcome, context.branchA);
  }
  console.log(`remediation PR: ${cloud.prUrl}`);
}

function createPullRequestOnBranch(
  outcome: RemediationOutcome,
  context: PullRequestContext,
  branch: string,
): void {
  runGh(["auth", "setup-git"]);
  assertDeveloperHeadUnchanged(context);
  verifiedCloudCommit(context, branch);

  const existing = openPullRequestsByHead().get(branch);
  if (existing) {
    retargetAndKeepRemediationPr(outcome, context, {
      branch,
      prUrl: existing,
    });
    return;
  }

  const prUrl = runGh([
    "pr",
    "create",
    "--repo",
    githubRepository(),
    "--head",
    branch,
    "--base",
    context.branchA,
    "--title",
    "Remediate Terraform policy denial",
    "--body",
    buildPrBody(outcome),
  ]);
  console.log(`remediation PR: ${prUrl}`);
}

function createRemediationPrFromCloudCommit(
  outcome: RemediationOutcome,
  context: PullRequestContext,
  cloud: CloudBranch,
): void {
  const branchB = remediationBranchName();

  runGh(["auth", "setup-git"]);
  assertDeveloperHeadUnchanged(context);
  const cloudCommit = verifiedCloudCommit(context, cloud.branch);

  runGit(["branch", branchB, cloudCommit]);
  runGit(["push", "-u", "origin", branchB]);
  if (
    cloud.branch !== branchB &&
    !cloud.branch.startsWith("cursor/") &&
    !protectedBranch(cloud.branch, context.branchA)
  ) {
    runGit(["push", "origin", "--delete", cloud.branch]);
  }

  const existing = openPullRequestsByHead().get(branchB);
  if (existing) {
    retargetAndKeepRemediationPr(outcome, context, {
      branch: branchB,
      prUrl: existing,
    });
    return;
  }

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

function protectedBranch(branch: string, branchA: string): boolean {
  return branch === "main" || branch === branchA || branch.startsWith("demo/");
}

function publishCloudRemediation(
  outcome: RemediationOutcome,
  context: PullRequestContext,
  cloud: CloudBranch,
  source: "sdk" | "discovered",
): void {
  runGh(["auth", "setup-git"]);
  const openPr = openPullRequestsByHead().get(cloud.branch);
  const keepUrl = cloud.branch.startsWith("cursor/")
    ? (cloud.prUrl ?? openPr)
    : source === "sdk"
      ? cloud.prUrl
      : undefined;
  if (keepUrl) {
    retargetAndKeepRemediationPr(outcome, context, {
      branch: cloud.branch,
      prUrl: keepUrl,
    });
    return;
  }
  if (
    cloud.branch.startsWith("cursor/") ||
    cloud.branch.startsWith("policy-remediation/")
  ) {
    createPullRequestOnBranch(outcome, context, cloud.branch);
    return;
  }
  if (openPr) {
    closePullRequestBestEffort(openPr);
  }
  createRemediationPrFromCloudCommit(outcome, context, cloud);
}

function verifyWorkingTreeRemediation(): string[] {
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
  return paths;
}

function createRemediationPrFromWorkingTree(
  outcome: RemediationOutcome,
  context: PullRequestContext,
): void {
  const remediations = verifyWorkingTreeRemediation();
  const branchB = remediationBranchName();

  runGh(["auth", "setup-git"]);
  assertDeveloperHeadUnchanged(context);
  if (runGit(["rev-parse", "HEAD"]) !== context.headSha) {
    throw new Error("checkout does not match the pull request head SHA");
  }

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
    retargetAndKeepRemediationPr(outcome, context, {
      branch: branchB,
      prUrl: existing,
    });
    return;
  }

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

async function applyLocalRemediation(prompt: string): Promise<void> {
  if (runningOnGitHubActions()) {
    throw new Error(
      "local Cursor SDK runtime is not invoked on GitHub Actions",
    );
  }

  const restoreGithubCredentials = hideGithubCredentials();
  try {
    const store = new JsonlLocalAgentStore(
      mkdtempSync(join(tmpdir(), "cursor-agent-")),
    );
    const result = await Agent.prompt(prompt, {
      apiKey: process.env.CURSOR_API_KEY,
      model: { id: "composer-2.5" },
      local: {
        cwd: repoRoot,
        store,
      },
    });
    console.log(`local run.id=${result.id} status=${result.status}`);
    if (result.status !== "finished") {
      throw new Error(`local investigator did not finish: ${result.status}`);
    }
    if (result.result) {
      console.log(`local run.result=${result.result}`);
    }
  } finally {
    restoreGithubCredentials();
  }
}

function dedupeCloudBranches(branches: CloudBranch[]): CloudBranch[] {
  const byBranch = new Map<string, CloudBranch>();
  for (const branch of branches) {
    const existing = byBranch.get(branch.branch);
    if (!existing || (!existing.prUrl && branch.prUrl)) {
      byBranch.set(branch.branch, branch);
    }
  }
  return [...byBranch.values()];
}

function autoCreatedPullRequests(
  context: PullRequestContext,
  openPrs: Map<string, string> = openPullRequestsByHead(),
): CloudBranch[] {
  const matches: CloudBranch[] = [];
  for (const [branch, prUrl] of openPrs) {
    if (!branch.startsWith("cursor/")) {
      continue;
    }
    try {
      const cloudCommit = fetchCloudBranch(branch);
      if (
        runGit(["merge-base", context.headSha, cloudCommit]) !== context.headSha
      ) {
        continue;
      }
      matches.push({ branch, prUrl });
    } catch (error) {
      console.log(
        `skipping cursor pull request ${branch}: ${errorMessage(error)}`,
      );
    }
  }
  return matches;
}

function createNoCodeFixIssue(
  outcome: NoCodeFixOutcome,
  context: PullRequestContext,
  cloudBranches: CloudBranch[],
): void {
  runGh(["auth", "setup-git"]);
  const openPrs = openPullRequestsByHead();
  const branches = dedupeCloudBranches([
    ...cloudBranches.map((cloud) => ({
      branch: cloud.branch,
      prUrl: cloud.prUrl ?? openPrs.get(cloud.branch),
    })),
    ...autoCreatedPullRequests(context, openPrs),
  ]);
  const changed: string[] = [];
  const inspections: string[] = [];
  const localPaths = changedPaths();
  if (localPaths.length > 0) {
    changed.push(...localPaths);
  }

  for (const cloud of branches) {
    let remotePaths: string[] = [];
    let fetched = false;
    try {
      const cloudCommit = fetchCloudBranch(cloud.branch);
      fetched = true;
      remotePaths = remoteChangedPaths(context.headSha, cloudCommit);
    } catch (error) {
      inspections.push(`${cloud.branch}: ${errorMessage(error)}`);
    }
    if (cloud.prUrl) {
      closePullRequestBestEffort(cloud.prUrl);
    }
    if (remotePaths.length > 0) {
      changed.push(...remotePaths.map((path) => `${cloud.branch}:${path}`));
      continue;
    }
    if (fetched && !protectedBranch(cloud.branch, context.branchA)) {
      runGit(["push", "origin", "--delete", cloud.branch]);
    }
  }
  if (changed.length > 0) {
    throw new Error(
      `no_code_fix outcome changed files; refusing issue creation: ${changed.join(", ")}`,
    );
  }
  if (inspections.length > 0) {
    throw new Error(
      `no_code_fix outcome could not be checked; refusing issue creation: ${inspections.join(", ")}`,
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
    process.env.GITHUB_REPOSITORY!,
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
    process.env.GITHUB_REPOSITORY!,
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

function extractCloudBranches(git: CloudGit | undefined): CloudBranch[] {
  return (
    git?.branches
      ?.filter(
        (branch): branch is typeof branch & { branch: string } =>
          typeof branch.branch === "string" && branch.branch !== "",
      )
      .map((branch) => ({ branch: branch.branch, prUrl: branch.prUrl })) ?? []
  );
}

function terraformPathFromArtifact(artifactPath: string): string | undefined {
  let relative = artifactPath.replace(/^\/+/, "");
  relative = relative.replace(/^workspace\//, "");
  if (relative.startsWith("artifacts/")) {
    relative = relative.slice("artifacts/".length);
  }
  relative = relative.replace(/^workspace\//, "");
  if (!isPermittedTerraformSource(relative)) {
    return undefined;
  }
  return relative;
}

async function downloadTerraformArtifacts(
  agent: SDKAgent,
): Promise<TerraformArtifact[]> {
  let artifacts: SDKArtifact[] = [];
  try {
    artifacts = await agent.listArtifacts();
  } catch (error) {
    console.log(`listArtifacts failed: ${errorMessage(error)}`);
    return [];
  }
  console.log(`cloud artifacts: ${JSON.stringify(artifacts)}`);

  const files: TerraformArtifact[] = [];
  for (const artifact of artifacts) {
    const path = terraformPathFromArtifact(artifact.path);
    if (!path) {
      continue;
    }
    try {
      files.push({
        path,
        contents: await agent.downloadArtifact(artifact.path),
      });
    } catch (error) {
      console.log(
        `downloadArtifact failed for ${artifact.path}: ${errorMessage(error)}`,
      );
    }
  }
  return files;
}

async function snapshotCloudPersist(
  agent: SDKAgent,
  runId: string,
  agentId: string,
  resultGit?: CloudGit,
): Promise<CloudPersistResult> {
  const terraformFiles = await downloadTerraformArtifacts(agent);
  const immediate = extractCloudBranches(resultGit);
  if (immediate.length > 0) {
    return { branches: immediate, terraformFiles };
  }

  try {
    const run = await Agent.getRun(runId, {
      runtime: "cloud",
      agentId,
      apiKey: process.env.CURSOR_API_KEY,
    });
    console.log(`cloud git snapshot: ${JSON.stringify(run.git ?? null)}`);
    return {
      branches: extractCloudBranches(run.git),
      terraformFiles,
    };
  } catch (error) {
    console.log(`Agent.getRun failed: ${errorMessage(error)}`);
    return { branches: [], terraformFiles };
  }
}

async function waitForCloudPersist(
  agent: SDKAgent,
  runId: string,
  agentId: string,
  resultGit?: CloudGit,
): Promise<CloudPersistResult> {
  const immediate = await snapshotCloudPersist(
    agent,
    runId,
    agentId,
    resultGit,
  );
  if (immediate.branches.length > 0 || immediate.terraformFiles.length > 0) {
    return immediate;
  }

  for (let attempt = 1; attempt <= CLOUD_PERSIST_ATTEMPTS; attempt += 1) {
    await sleep(CLOUD_PERSIST_DELAY_MS);
    const snapshot = await snapshotCloudPersist(agent, runId, agentId);
    console.log(
      `cloud persist poll ${attempt}: branches=${JSON.stringify(snapshot.branches)} files=${snapshot.terraformFiles.map((file) => file.path).join(",") || "(none)"}`,
    );
    if (snapshot.branches.length > 0 || snapshot.terraformFiles.length > 0) {
      return snapshot;
    }
  }

  return { branches: [], terraformFiles: [] };
}

async function sendCloudPersistFollowUp(agent: SDKAgent): Promise<{
  id: string;
  git?: CloudGit;
  status: string;
  terraformFiles: TerraformArtifact[];
}> {
  const run = await agent.send(buildPersistPrompt(), { mode: "agent" });
  console.log(`persist run.id=${run.id}`);
  const { result, terraformFiles } = await waitForRun(run, "persist");
  console.log(`persist run.id=${result.id} status=${result.status}`);
  console.log(`persist run.git=${JSON.stringify(result.git ?? null)}`);
  if (result.error) {
    console.log(`persist run.error=${JSON.stringify(result.error)}`);
  }
  if (result.result) {
    console.log(`persist run.result=${result.result}`);
  }
  return {
    id: result.id,
    git: result.git,
    status: result.status,
    terraformFiles,
  };
}

async function requestCloudWorkspacePersist(
  agent: SDKAgent,
): Promise<CloudPersistResult> {
  console.log(
    "cloud investigator produced no named branch; requesting persist of the already decided Terraform edit immediately",
  );
  let persistRun = await sendCloudPersistFollowUp(agent);
  if (persistRun.status !== "finished") {
    console.log(
      `persist follow-up did not finish: ${persistRun.status}; retrying on a resumed cloud agent`,
    );
    await using resumed = await Agent.resume(agent.agentId, {
      apiKey: process.env.CURSOR_API_KEY,
      model: { id: "composer-2.5" },
    });
    persistRun = await sendCloudPersistFollowUp(resumed);
    if (persistRun.status !== "finished") {
      console.log(
        `persist retry did not finish: ${persistRun.status}; continuing with other cloud recovery paths`,
      );
    }
    const snapshot = await waitForCloudPersist(
      resumed,
      persistRun.id,
      resumed.agentId,
      persistRun.git,
    );
    return {
      branches: snapshot.branches,
      terraformFiles: mergeTerraformFiles([
        ...persistRun.terraformFiles,
        ...snapshot.terraformFiles,
      ]),
    };
  }
  const snapshot = await waitForCloudPersist(
    agent,
    persistRun.id,
    agent.agentId,
    persistRun.git,
  );
  return {
    branches: snapshot.branches,
    terraformFiles: mergeTerraformFiles([
      ...persistRun.terraformFiles,
      ...snapshot.terraformFiles,
    ]),
  };
}

function applyDownloadedTerraformFiles(files: TerraformArtifact[]): void {
  if (files.length === 0) {
    throw new Error("cloud investigator produced no Terraform artifacts");
  }
  for (const file of files) {
    if (!isPermittedTerraformSource(file.path)) {
      throw new Error(
        `investigator artifact is not permitted Terraform source: ${file.path}`,
      );
    }
    const absolutePath = join(repoRoot, file.path);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, file.contents);
    console.log(`copied cloud artifact to ${file.path}`);
  }
  try {
    execFileSync(
      "terraform",
      ["fmt", "--", ...files.map((file) => file.path)],
      { cwd: repoRoot, stdio: "inherit", env: process.env },
    );
  } catch (error) {
    console.log(`terraform fmt skipped: ${errorMessage(error)}`);
  }
}

function reservedBranch(branch: string, branchA: string): boolean {
  return (
    branch === "main" ||
    branch === branchA ||
    branch.startsWith("demo/") ||
    branch.startsWith("policy-remediation/")
  );
}

function openPullRequestsByHead(): Map<string, string> {
  const raw = runGh([
    "pr",
    "list",
    "--repo",
    process.env.GITHUB_REPOSITORY!,
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

function remoteHeadNames(): string[] {
  const output = runGit(["ls-remote", "--heads", "origin"]);
  return output
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t")[1]?.replace(/^refs\/heads\//, ""))
    .filter((branch): branch is string => Boolean(branch));
}

function findPersistedCloudRemediation(
  context: PullRequestContext,
): CloudBranch[] {
  runGh(["auth", "setup-git"]);
  const prByHead = openPullRequestsByHead();
  const heads = [...new Set([...prByHead.keys(), ...remoteHeadNames()])].filter(
    (branch) => !reservedBranch(branch, context.branchA),
  );
  const preferred = heads.filter((branch) => branch.startsWith("cursor/"));
  const candidates = preferred.length > 0 ? preferred : heads;
  console.log(
    `scanning ${candidates.length} candidate branches for persisted cloud remediation`,
  );
  const matches: CloudBranch[] = [];

  for (const branch of candidates) {
    let cloudCommit: string;
    try {
      cloudCommit = fetchCloudBranch(branch);
    } catch (error) {
      console.log(
        `skipping candidate branch ${branch}: ${errorMessage(error)}`,
      );
      continue;
    }
    if (
      runGit(["merge-base", context.headSha, cloudCommit]) !== context.headSha
    ) {
      continue;
    }

    try {
      verifyRemediationChanges(context.headSha, cloudCommit);
    } catch (error) {
      const prUrl = prByHead.get(branch);
      const message = errorMessage(error);
      const cursorPullRequest = branch.startsWith("cursor/") && prUrl;
      if (cursorPullRequest && /blocked files|symbolic links/.test(message)) {
        closePullRequestBestEffort(prUrl);
        throw error;
      }
      if (cursorPullRequest && message.includes("no Terraform remediation")) {
        closePullRequestBestEffort(prUrl);
        console.log(`closed empty auto-created pull request ${prUrl}`);
        continue;
      }
      console.log(`skipping candidate branch ${branch}: ${message}`);
      continue;
    }
    matches.push({ branch, prUrl: prByHead.get(branch) });
  }
  return matches;
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

async function openRemediationPullRequest(
  outcome: RemediationOutcome,
  context: PullRequestContext,
  persist: CloudPersistResult,
  prompt: string,
): Promise<void> {
  if (persist.branches.length > 1) {
    throw new Error(
      `remediation outcome requires exactly one investigator branch; found ${persist.branches.length}`,
    );
  }
  if (persist.branches.length === 1) {
    publishCloudRemediation(outcome, context, persist.branches[0], "sdk");
    return;
  }

  const discovered = findPersistedCloudRemediation(context);
  if (discovered.length > 1) {
    throw new Error(
      `remediation outcome requires exactly one investigator branch; found ${discovered.length}`,
    );
  }
  if (discovered.length === 1) {
    console.log(
      `found persisted cloud branch ${discovered[0].branch} without SDK branch name`,
    );
    publishCloudRemediation(outcome, context, discovered[0], "discovered");
    return;
  }

  if (persist.terraformFiles.length > 0) {
    console.log(
      "cloud investigator persisted Terraform artifacts; copying them into the checkout",
    );
    applyDownloadedTerraformFiles(persist.terraformFiles);
    createRemediationPrFromWorkingTree(outcome, context);
    return;
  }

  if (!runningOnGitHubActions()) {
    console.log(
      "cloud investigator produced no persisted branch; applying a local workspace edit",
    );
    await applyLocalRemediation(prompt);
    createRemediationPrFromWorkingTree(outcome, context);
    return;
  }

  throw new Error(
    "cloud investigator produced a remediation but no named branch, Terraform artifacts, or Cursor pull request",
  );
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

  let result;
  let outcome: InvestigatorOutcome | undefined;
  let persist: CloudPersistResult = { branches: [], terraformFiles: [] };
  const restoreGithubCredentials = hideGithubCredentials();
  try {
    const repository = process.env.GITHUB_REPOSITORY!;
    const server = process.env.GITHUB_SERVER_URL ?? "https://github.com";
    await using agent = await Agent.create({
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
        autoCreatePR: true,
        skipReviewerRequest: true,
      },
    });
    console.log(`agent.id=${agent.agentId}`);
    const run = await agent.send(prompt, { mode: "agent" });
    console.log(`run.id=${run.id}`);
    const waited = await waitForRun(run, "investigate");
    result = waited.result;
    console.log(`run.id=${result.id} status=${result.status}`);
    console.log(`run.git=${JSON.stringify(result.git ?? null)}`);

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
    persist = await snapshotCloudPersist(
      agent,
      result.id,
      agent.agentId,
      result.git,
    );
    persist = {
      branches: persist.branches,
      terraformFiles: mergeTerraformFiles([
        ...waited.terraformFiles,
        ...persist.terraformFiles,
      ]),
    };
    if (
      outcome.outcome === "remediation" &&
      persist.branches.length === 0 &&
      persist.terraformFiles.length === 0
    ) {
      persist = await requestCloudWorkspacePersist(agent);
      persist = {
        branches: persist.branches,
        terraformFiles: mergeTerraformFiles([
          ...waited.terraformFiles,
          ...persist.terraformFiles,
        ]),
      };
    } else if (
      persist.branches.length === 0 &&
      persist.terraformFiles.length === 0
    ) {
      persist = await waitForCloudPersist(
        agent,
        result.id,
        agent.agentId,
        result.git,
      );
    }
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
    await openRemediationPullRequest(outcome, context, persist, prompt);
    return;
  }
  createNoCodeFixIssue(outcome, context, persist.branches);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});

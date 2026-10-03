import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Agent, CursorAgentError, JsonlLocalAgentStore } from "@cursor/sdk";

const repoRoot = process.cwd();

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
    "Start from artifacts/policy-result.json and artifacts/plan.json. Inspect any repository files needed for the investigation.",
    "",
    "Determine whether a safe compliant code remediation can be made using only the repository and available plan/policy context.",
    "",
    "If yes:",
    "- make the smallest compliant change",
    "- minimize blast radius",
    "- modify only Terraform .tf source files",
    "- do not modify policy",
    '- return outcome="remediation"',
    "",
    "If no safe code fix can be justified:",
    "- do not edit source files",
    '- return outcome="no_code_fix"',
    "- explain what information, exception, ownership decision, or external dependency is required",
    "",
    "Do not commit, push, create branches, create pull requests, create issues, or post GitHub comments.",
    "Orchestration handles all GitHub mechanics.",
    "",
    "Return only one JSON object, with no Markdown fence or other text, matching exactly one of these shapes:",
    "",
    '{"outcome":"remediation","violation":"...","rootCause":"...","filesExamined":["..."],"remediation":"...","whyThisLocation":"..."}',
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

function verifyRemediationChanges(): string[] {
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

function createRemediationPr(
  outcome: RemediationOutcome,
  context: PullRequestContext,
): void {
  const remediations = verifyRemediationChanges();
  const branchB = remediationBranchName();

  runGh(["auth", "setup-git"]);
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

  runGit(["checkout", "-b", branchB, context.headSha]);
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

  const prUrl = runGh([
    "pr",
    "create",
    "--repo",
    process.env.GITHUB_REPOSITORY!,
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

function createNoCodeFixIssue(
  outcome: NoCodeFixOutcome,
  context: PullRequestContext,
): void {
  const paths = changedPaths();
  if (paths.length > 0) {
    throw new Error(
      `no_code_fix outcome changed files; refusing issue creation: ${paths.join(", ")}`,
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

  let result;
  const restoreGithubCredentials = hideGithubCredentials();
  try {
    const store = new JsonlLocalAgentStore(
      mkdtempSync(join(tmpdir(), "cursor-agent-")),
    );
    result = await Agent.prompt(prompt, {
      apiKey: process.env.CURSOR_API_KEY,
      model: { id: "composer-2.5" },
      local: {
        cwd: repoRoot,
        store,
      },
    });
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

  const outcome = parseOutcome(result.result ?? "");
  console.log(JSON.stringify(outcome, null, 2));
  if (outcome.outcome === "remediation") {
    createRemediationPr(outcome, context);
  } else {
    createNoCodeFixIssue(outcome, context);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});

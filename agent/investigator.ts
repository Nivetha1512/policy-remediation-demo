import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { Agent, CursorAgentError } from "@cursor/sdk";

const repoRoot = process.cwd();

type PolicyResult = {
  deny?: unknown;
  pass?: unknown;
};

function runGit(args: string[], options: { allowFailure?: boolean } = {}): string {
  try {
    return execFileSync("git", args, {
      cwd: repoRoot,
      encoding: "utf8",
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
  const status = runGit(["status", "--porcelain"]);
  if (!status) {
    return [];
  }
  return status
    .split("\n")
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
}

function isTerraformSource(path: string): boolean {
  return path.endsWith(".tf") && !path.includes("..");
}

function buildPrompt(): string {
  return [
    "A Terraform policy check failed.",
    "",
    "Investigate the denial using only the repository and generated Terraform plan artifacts.",
    "",
    "Follow AGENTS.md.",
    "",
    "Start from artifacts/policy-result.json and artifacts/plan.json.",
    "You may also inspect AGENTS.md, main.tf, modules/, policies/, scripts/, and any other file inside this repository that you need.",
    "",
    "Determine the root cause and make the smallest compliant code remediation.",
    "",
    "Do not modify, weaken, bypass, or delete policy.",
    "Do not assume the fix belongs in the resource, reusable module, or caller.",
    "Do not run ./scripts/verify.sh. Local checks are not the authoritative result.",
    "You may run terraform fmt on files you change.",
    "Do not commit, push, create a branch, or open a pull request. Orchestration will do that after you finish.",
    "",
    "When you are done, return a concise remediation summary using only these headings:",
    "",
    "Violation",
    "",
    "Root cause",
    "",
    "Files examined",
    "",
    "Remediation",
    "",
    "Why this location",
    "",
    "Verification",
    "Pending GitHub Actions / OPA policy check",
  ].join("\n");
}

function buildPrBody(summary: string): string {
  const trimmed = summary.trim();
  if (trimmed.length > 0) {
    return trimmed;
  }

  return [
    "Violation",
    "",
    "A Terraform policy check failed. See artifacts/policy-result.json.",
    "",
    "Root cause",
    "",
    "The investigator did not return a root-cause summary.",
    "",
    "Files examined",
    "",
    "See the investigator run.",
    "",
    "Remediation",
    "",
    "See the committed diff.",
    "",
    "Why this location",
    "",
    "See the committed diff.",
    "",
    "Verification",
    "",
    "Pending GitHub Actions / OPA policy check",
  ].join("\n");
}

function createRemediationPr(summary: string): void {
  const paths = changedPaths();
  const remediations = paths.filter((path) => isTerraformSource(path));
  const ignored = paths.filter((path) => !isTerraformSource(path));

  if (ignored.length > 0) {
    console.log(
      `ignoring non-Terraform changes: ${ignored.join(", ")}`
    );
  }

  if (remediations.length === 0) {
    throw new Error("investigator produced no Terraform (.tf) remediation");
  }

  const branch = `policy-remediation/${process.env.GITHUB_RUN_ID ?? Date.now()}`;
  const base = process.env.GITHUB_BASE_REF || "main";

  runGit(["checkout", "-B", branch]);
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
      "Remediate Terraform policy denial.",
    ],
    { cwd: repoRoot, stdio: "inherit" }
  );
  runGit(["push", "-u", "origin", "HEAD"]);

  execFileSync(
    "gh",
    [
      "pr",
      "create",
      "--title",
      "Remediate Terraform policy denial",
      "--body",
      buildPrBody(summary),
      "--base",
      base,
    ],
    { cwd: repoRoot, stdio: "inherit" }
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

  let result;
  try {
    result = await Agent.prompt(buildPrompt(), {
      apiKey: process.env.CURSOR_API_KEY,
      model: { id: "composer-2.5" },
      local: { cwd: repoRoot },
    });
  } catch (error) {
    if (error instanceof CursorAgentError) {
      console.error(
        `startup failed: ${error.message}, retryable=${error.isRetryable}`
      );
      process.exitCode = 1;
      return;
    }
    throw error;
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

  createRemediationPr(result.result ?? "");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});

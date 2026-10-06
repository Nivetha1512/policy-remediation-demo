# Policy Failure Investigator

This prototype demonstrates an AI agent that investigates a Terraform policy denial and either produces the smallest compliant remediation or reports that no safe code fix can be justified. The policy engine remains authoritative. The agent must never weaken, bypass, disable, or rewrite policy just to make a check pass.

## What OPA does

OPA inspects Terraform plan JSON and decides whether the plan is allowed.

## What the AI investigator does

The investigator starts only after a denial. It identifies the offending planned resource, traces the planned value back through configuration, and returns either a safe, minimal Terraform remediation or a structured `no_code_fix` result.

## Why the AI is not replacing OPA

OPA remains the authority that allows or denies a plan. The investigator proposes a configuration change and returns that change to the same policy. Policy text stays in force for every check.

## Repository

This prototype is published at [github.com/Nivetha1512/policy-remediation-demo](https://github.com/Nivetha1512/policy-remediation-demo).

## Prerequisites

`terraform` and `opa` must be on the `PATH`.

The demo is plan-only and local. The AWS provider uses mock credentials and skip flags so no real AWS account or apply is required.

## Run the broken scenario

```bash
./scripts/plan.sh
./scripts/policy-check.sh
```

The policy check is expected to fail before remediation.

## Reset the demo

```bash
./scripts/reset-demo.sh
```

The reset script requires a clean working tree. It updates local `main` to `origin/main`, closes open demo pull requests, and removes existing demo and remediation branches. It then recreates and pushes:

- `demo/encryption-failure`
- `demo/kms-failure`

The encryption branch receives the Terraform caller fixture from `fixtures/encryption/`. The KMS branch receives the policy fixture from `fixtures/kms/`. The script returns to clean `main` when setup is complete.

## Ask Cursor to investigate

Tell Cursor to follow `AGENTS.md`, investigate the policy failure, and produce the structured investigation outcome.

Local checks are not the authoritative result. The GitHub Actions policy gate on the remediation pull request is.

## GitHub Actions policy gate

The `policy-check` job runs Terraform fmt, validate, and plan, then evaluates the same OPA policy. It does not apply infrastructure and does not use AWS credentials.

A red `policy-check` on the broken caller is expected. That is the policy engine denying the plan.

If and only if OPA returns a denial on an in-repository pull request, the `investigate` job starts a Cursor SDK cloud investigator from the pull-request head. Local `@cursor/sdk` execution on GitHub Actions crashes (exit 139), so CI never invokes `Agent.create` or `Agent.prompt` with a local runtime. Formatting, validation, plan, and dependency failures do not start the investigator. Heads named `cursor/*` and `policy-remediation/*` skip investigation so a remediation pull request is verified by OPA without recursively launching another investigator.

The agent has no workflow GitHub token. `autoCreatePR` is off, so Cursor does not create a branch or pull request. The agent edits Terraform in its cloud workspace with Write or StrReplace and returns one JSON object. For a remediation, `files` carries the full text of each changed `.tf` file.

`investigator.ts` is the sole publisher. It writes those contents onto the developer-head checkout, runs `terraform fmt` on them, and commits only those files on `policy-remediation/<run id>-<run attempt>` from the developer head. It pushes that branch and opens one pull request whose head is that branch and whose base is the developer branch. If that head already has an open pull request, the script retargets its base to the developer branch and replaces the title and body. The script publishes only the `files` array from the investigator JSON. It does not read the tool stream, cloud artifacts, `result.git`, or a `cursor/*` branch as the remediation. An open `cursor/*` pull request based on the same developer head is closed as cleanup.

For a `remediation` outcome, the script publishes a diff. Those paths come from `files`, and each one must still be permitted Terraform source. The script checks that set after writing the files and before `git push`, then checks the pushed commit again before `gh pr create`. It does not push to the developer branch or `main` and never auto-merges. A missing or empty `files` array, empty contents, or a path that is not permitted Terraform source fails the run. If blocked files changed, the script refuses the remediation pull request. The green OPA check after a human merges the remediation pull request into the developer branch is authoritative for the original pull request.

For a `no_code_fix` outcome, the script creates no remediation branch and no remediation pull request. It requires a clean working tree, creates one follow-up issue from the investigator's explanation, and comments once on the original pull request. It also closes a stray `cursor/*` pull request based on that head.

### Required GitHub configuration

- Repository secret `CURSOR_API_KEY`: Cursor user or service-account API key for `@cursor/sdk`.
- Workflow token permissions: `contents: write`, `pull-requests: write`, and `issues: write`.
- Repository Actions setting: allow GitHub Actions to create pull requests.

Create the key at [Cursor Dashboard → Integrations](https://cursor.com/dashboard/integrations) or in team service-account settings. Add it as a repository secret named `CURSOR_API_KEY`. Do not commit the value.

GitHub's automatic `GITHUB_TOKEN` is used only after investigation to commit and push the remediation branch, open or retarget that pull request, or create and link a follow-up issue. Fork pull requests are skipped because an upstream remediation pull request cannot target a branch that exists only in a fork.

### Demo sequence

1. Keep the original caller in the broken state, or run `./scripts/reset-demo.sh`.
2. Open a pull request from a developer branch to `main`.
3. Watch `policy-check` fail on the OPA denial.
4. If the result is `remediation`, review and merge the remediation pull request into the developer branch.
5. The new commit on the developer branch reruns the original pull request's fmt, validate, plan, and OPA checks.
6. If the result is `no_code_fix`, use the linked issue to supply the required decision, exception, or external dependency. The original pull request remains blocked.

## A weaker approach

Flipping the first boolean mentioned by an error is weaker than tracing the planned value, comparing remediation points and blast radius, and verifying against the same policy.

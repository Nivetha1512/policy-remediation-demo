# Policy Failure Investigator

This prototype demonstrates an AI agent that investigates a Terraform policy denial and produces the smallest compliant remediation. The policy engine remains authoritative. The agent must never weaken, bypass, disable, or rewrite policy just to make a check pass.

## What OPA does

OPA inspects Terraform plan JSON and decides whether the plan is allowed.

## What the AI investigator does

The investigator starts only after a denial. It identifies the offending planned resource, traces the planned value back through configuration, chooses where a fix belongs, makes the smallest reasonable HCL change, and re-runs validation plus the same policy.

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

This restores the original broken caller, regenerates the plan, and re-runs the policy check. It does not propose a remediation.

## Ask Cursor to investigate

Tell Cursor to follow `AGENTS.md`, investigate the policy failure, and produce the remediation report.

## Verify

```bash
./scripts/verify.sh
```

`./scripts/verify.sh` runs `terraform fmt -check`, `terraform validate`, regenerates the plan, and re-runs the same OPA policy.

## GitHub Actions policy gate

The `policy-check` job runs Terraform fmt, validate, and plan, then evaluates the same OPA policy. It does not apply infrastructure and does not use AWS credentials.

A red `policy-check` on the broken caller is expected. That is the policy engine denying the plan.

If and only if OPA returns a denial, the `investigate` job starts a Cursor SDK cloud investigator against this GitHub repository. Local SDK execution on GitHub Actions crashed (exit 139), so CI does not load the local native agent. Formatting, validation, plan, and dependency failures do not start the investigator. Branches named `policy-remediation/*` also skip it so a remediation pull request is verified by OPA, not investigated again.

The investigator edits code only. Orchestration then opens a new remediation branch and pull request. That pull request runs this same workflow. The green OPA check on the remediation pull request is the authoritative result. The investigator does not claim success itself.

### Required GitHub secret

| Secret | Purpose |
| --- | --- |
| `CURSOR_API_KEY` | Cursor user or service-account API key for `@cursor/sdk` |

Create the key at [Cursor Dashboard → Integrations](https://cursor.com/dashboard/integrations) or in team service-account settings. Add it as a repository secret named `CURSOR_API_KEY`. Do not commit the value.

GitHub's `GITHUB_TOKEN` is used to push the remediation branch and open the pull request.

### Demo sequence

1. Keep the original caller in the broken state, or run `./scripts/reset-demo.sh`.
2. Push to `main` or open a pull request.
3. Watch `policy-check` fail on the OPA denial.
4. If `CURSOR_API_KEY` is set, `investigate` opens a `policy-remediation/*` pull request.
5. The remediation pull request reruns fmt, validate, plan, and OPA.
6. A green OPA check on that pull request is success.

## A weaker approach

Flipping the first boolean mentioned by an error is weaker than tracing the planned value, comparing remediation points and blast radius, and verifying against the same policy.

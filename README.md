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

The `policy-check` workflow runs `./scripts/verify.sh` on every push to `main` and every pull request. It installs Terraform 1.9.0 and OPA 1.21.1. It does not apply infrastructure and does not use AWS credentials.

A red check on the broken caller is expected. That is the policy engine denying the plan. After a compliant HCL change, the same workflow should pass. `./scripts/reset-demo.sh` returns the demo to a failing gate.

## A weaker approach

Flipping the first boolean mentioned by an error is weaker than tracing the planned value, comparing remediation points and blast radius, and verifying against the same policy.

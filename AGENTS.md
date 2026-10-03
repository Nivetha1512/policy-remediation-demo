# Agent instructions

Investigate a Terraform policy denial and produce the smallest compliant remediation. These principles are binding.

## Principles

- The policy engine is authoritative.
- Never modify, weaken, delete, disable, or bypass policy solely to make validation pass.
- Investigate before editing.
- Trace the violating planned value back to the configuration that produced it.
- Consider every plausible remediation point.
- Evaluate blast radius.
- Prefer the smallest compliant change.
- Do not assume the fix belongs in the resource, the reusable module, or the caller.
- Do not change reusable module defaults unless that is clearly the intended scope.
- After editing, you may run `terraform fmt` on files you change. Do not treat local checks as final verification. The GitHub Actions policy gate on the remediation pull request is authoritative.
- If no safe compliant code remediation can be justified from repository and policy context, do not edit source files. Report what information, exception, ownership decision, or external dependency is required.
- Never commit, push, create or switch branches, create pull requests or issues, or post GitHub comments. Deterministic orchestration handles Git and GitHub operations.

## Investigation result

Return exactly one machine-readable outcome:

- `remediation` when a safe compliant code change was made.
- `no_code_fix` when a safe code change cannot be justified.

## Branch naming

Demo violation branches:

- `demo/encryption-failure`
- `demo/kms-failure`

Agent-generated remediation branches:

- `policy-remediation/<short-description-or-run-id>`

Do not create ad hoc `cursor/*` or `fix/*` branches for the demo workflow.

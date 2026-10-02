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
- After editing, format, validate, regenerate the plan, and re-run the same policy via `./scripts/verify.sh`.
- If no compliant code remediation exists, stop and report that an exception or human decision is required.

## Remediation report

Fill this report from the investigation. Use only these headings.

### Violation

### Root cause

### Files examined

### Remediation

### Why this location

### Verification

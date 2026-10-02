#!/usr/bin/env bash
set -euo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/.."

if [[ ! -f artifacts/plan.json ]]; then
  echo "error: artifacts/plan.json not found; run ./scripts/plan.sh first" >&2
  exit 1
fi

opa eval --format pretty \
  -i artifacts/plan.json \
  -d policies/ \
  '{"deny": data.terraform.deny, "pass": count(data.terraform.deny) == 0}' \
  > artifacts/policy-result.json

pass="$(opa eval --format raw -i artifacts/plan.json -d policies/ 'count(data.terraform.deny) == 0')"

if [[ "${pass}" == "true" ]]; then
  echo "OPA policy PASS"
  exit 0
fi

opa eval --format raw -i artifacts/plan.json -d policies/ 'data.terraform.deny[_]' |
  while IFS= read -r line; do
    msg="${line#\"}"
    msg="${msg%\"}"
    printf 'DENY: %s\n' "${msg}"
  done

exit 1

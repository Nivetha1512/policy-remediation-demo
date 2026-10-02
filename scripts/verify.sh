#!/usr/bin/env bash
set -euo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/.."

failed=0

run() {
  local label="$1"
  shift
  if "$@"; then
    echo "PASS: ${label}"
  else
    echo "FAIL: ${label}"
    failed=1
  fi
}

run "terraform fmt -check -recursive" terraform fmt -check -recursive
run "terraform validate" terraform validate
run "./scripts/plan.sh" ./scripts/plan.sh
run "./scripts/policy-check.sh" ./scripts/policy-check.sh

if [[ "${failed}" -eq 0 ]]; then
  echo "Verification passed."
else
  echo "Verification failed."
  exit 1
fi

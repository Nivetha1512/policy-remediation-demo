#!/usr/bin/env bash
set -euo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/.."

if [[ ! -f artifacts/plan.json ]]; then
  echo "error: artifacts/plan.json not found; run ./scripts/plan.sh first" >&2
  exit 1
fi

opa eval --format json -i artifacts/plan.json -d policies/ 'data.terraform.deny' \
  | python3 -c '
import json
import sys

try:
    raw = json.load(sys.stdin)
except json.JSONDecodeError as exc:
    print(f"error: failed to parse opa eval JSON: {exc}", file=sys.stderr)
    sys.exit(1)

messages = []
result = raw.get("result") if isinstance(raw, dict) else None
if isinstance(result, list) and result and isinstance(result[0], dict):
    expressions = result[0].get("expressions")
    if isinstance(expressions, list) and expressions and isinstance(expressions[0], dict):
        value = expressions[0].get("value", [])
        if isinstance(value, list):
            messages = [item if isinstance(item, str) else str(item) for item in value]

out = {"deny": messages, "pass": len(messages) == 0}
with open("artifacts/policy-result.json", "w", encoding="utf-8") as fh:
    json.dump(out, fh)
    fh.write("\n")

if messages:
    for msg in messages:
        print(f"DENY: {msg}")
    sys.exit(1)

print("OPA policy PASS")
'

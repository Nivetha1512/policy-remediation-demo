#!/usr/bin/env bash
set -euo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/.."

cat > main.tf <<'EOF'
module "database" {
  source      = "./modules/database"
  environment = "prod"
}
EOF

terraform fmt main.tf >/dev/null
rm -f artifacts/remediation-report.txt

./scripts/plan.sh

set +e
./scripts/policy-check.sh
policy_status=$?
set -e

if [[ "${policy_status}" -eq 0 ]]; then
  echo "error: policy check passed after reset" >&2
  exit 1
fi

echo "Demo reset to the original broken configuration."

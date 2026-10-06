#!/usr/bin/env bash
set -euo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/.."

mkdir -p artifacts
terraform -chdir=terraform init -input=false
terraform -chdir=terraform plan -out=../artifacts/plan.tfplan -input=false
terraform -chdir=terraform show -json ../artifacts/plan.tfplan > artifacts/plan.json

echo "artifacts/plan.json was written"

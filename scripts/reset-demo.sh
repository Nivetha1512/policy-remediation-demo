#!/usr/bin/env bash
set -euo pipefail

readonly EXPECTED_REPOSITORY="Nivetha1512/policy-remediation-demo"
readonly REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly FIXED_COMMIT_DATE="2000-01-01T00:00:00Z"
readonly DEMO_BRANCHES=(
  "demo/encryption-failure"
  "demo/kms-failure"
)

cd "${REPO_ROOT}"

fail() {
  echo "error: $*" >&2
  exit 1
}

delete_remote_branch() {
  local branch="$1"

  if gh api \
    "repos/${EXPECTED_REPOSITORY}/git/ref/heads/${branch}" \
    >/dev/null 2>&1; then
    gh api \
      --method DELETE \
      "repos/${EXPECTED_REPOSITORY}/git/refs/heads/${branch}" \
      >/dev/null
  fi
}

delete_local_branch() {
  local branch="$1"

  if git show-ref --verify --quiet "refs/heads/${branch}"; then
    git branch --delete --force --quiet "${branch}"
  fi
}

commit_fixture() {
  local message="$1"
  shift

  GIT_AUTHOR_DATE="${FIXED_COMMIT_DATE}" \
    GIT_COMMITTER_DATE="${FIXED_COMMIT_DATE}" \
    git \
      -c user.name="policy-demo[bot]" \
      -c user.email="policy-demo[bot]@users.noreply.github.com" \
      commit --quiet --message "${message}" -- "$@"
}

[[ "$(git rev-parse --show-toplevel)" == "${REPO_ROOT}" ]] ||
  fail "run this script from the Policy Failure Investigator repository"

origin_url="$(git remote get-url origin)"
case "${origin_url}" in
  "https://github.com/${EXPECTED_REPOSITORY}" | \
    "https://github.com/${EXPECTED_REPOSITORY}.git" | \
    "git@github.com:${EXPECTED_REPOSITORY}.git" | \
    "ssh://git@github.com/${EXPECTED_REPOSITORY}.git")
    ;;
  *)
    fail "unexpected origin remote: ${origin_url}"
    ;;
esac

if [[ -n "$(git status --porcelain)" ]]; then
  fail "working tree must be clean before resetting the demo"
fi

command -v gh >/dev/null 2>&1 || fail "gh is required"
command -v terraform >/dev/null 2>&1 || fail "terraform is required"
command -v opa >/dev/null 2>&1 || fail "opa is required"
[[ "$(gh repo view --json nameWithOwner --jq '.nameWithOwner')" == \
  "${EXPECTED_REPOSITORY}" ]] ||
  fail "GitHub CLI is not connected to ${EXPECTED_REPOSITORY}"

git fetch origin --prune --quiet
git rev-parse --verify "origin/main^{commit}" >/dev/null
git switch --quiet main
git reset --hard --quiet origin/main

[[ -f fixtures/encryption/main.tf ]] ||
  fail "fixtures/encryption/main.tf is missing from main"
[[ -f fixtures/kms/require-prod-kms.rego ]] ||
  fail "fixtures/kms/require-prod-kms.rego is missing from main"

return_to_main() {
  local reset_status=$?
  local current_branch

  trap - EXIT
  current_branch="$(git branch --show-current)"
  case "${current_branch}" in
    "demo/encryption-failure" | "demo/kms-failure")
      git reset --hard --quiet
      git switch --quiet main
      ;;
  esac
  exit "${reset_status}"
}
trap return_to_main EXIT

while IFS= read -r number; do
  [[ -n "${number}" ]] || continue
  gh pr close "${number}" \
    --repo "${EXPECTED_REPOSITORY}" \
    --comment "Closing stale demo pull request during deterministic reset." \
    >/dev/null 2>&1
done < <(
  gh pr list \
    --repo "${EXPECTED_REPOSITORY}" \
    --state open \
    --limit 1000 \
    --json isCrossRepository,number \
    --jq '.[] | select(.isCrossRepository == false) | .number'
)

while IFS= read -r number; do
  [[ -n "${number}" ]] || continue
  gh issue close "${number}" \
    --repo "${EXPECTED_REPOSITORY}" \
    --comment "Closing stale demo issue during deterministic reset." \
    >/dev/null 2>&1
done < <(
  gh issue list \
    --repo "${EXPECTED_REPOSITORY}" \
    --state open \
    --limit 1000 \
    --json number \
    --jq '.[].number'
)

for branch in "${DEMO_BRANCHES[@]}"; do
  delete_remote_branch "${branch}"
done

while IFS= read -r branch; do
  [[ -n "${branch}" ]] && delete_remote_branch "${branch}"
done < <(
  gh api \
    "repos/${EXPECTED_REPOSITORY}/git/matching-refs/heads/policy-remediation/" \
    --paginate \
    --jq '.[] | .ref | sub("^refs/heads/"; "")'
)

git fetch origin --prune --quiet

for branch in "${DEMO_BRANCHES[@]}"; do
  delete_local_branch "${branch}"
done

while IFS= read -r branch; do
  [[ -n "${branch}" ]] && delete_local_branch "${branch}"
done < <(
  git for-each-ref \
    --format='%(refname:strip=2)' \
    'refs/heads/policy-remediation/*'
)

git switch --quiet --create "demo/encryption-failure" main
cp fixtures/encryption/main.tf terraform/main.tf
terraform -chdir=terraform fmt main.tf >/dev/null
git add terraform/main.tf
commit_fixture "Create encryption policy failure demo" terraform/main.tf
git push --quiet --set-upstream origin "demo/encryption-failure"

git switch --quiet main
git switch --quiet --create "demo/kms-failure" main
cp fixtures/kms/require-prod-kms.rego policies/require-prod-kms.rego
opa fmt --write policies/require-prod-kms.rego
git add policies/require-prod-kms.rego
commit_fixture \
  "Create KMS policy failure demo" \
  policies/require-prod-kms.rego
git push --quiet --set-upstream origin "demo/kms-failure"

git switch --quiet main
trap - EXIT

cat <<'EOF'
Demo reset complete.

Closed open pull requests and issues.

Ready branches:
- demo/encryption-failure
- demo/kms-failure

Baseline:
- main
EOF

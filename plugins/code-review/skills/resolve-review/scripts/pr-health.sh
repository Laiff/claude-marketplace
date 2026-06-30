#!/usr/bin/env bash
# pr-health.sh — Check PR state, draft status, mergeability
# Usage: pr-health.sh <PR_NUMBER>
# Output: JSON with state, draft, mergeable fields
# Exit 0: PR is actionable (OPEN, not draft, no conflicts)
# Exit 1: PR is not actionable (closed/merged/draft/conflicting) — reason on stderr
set -euo pipefail

PR_NUMBER="${1:?Usage: pr-health.sh <PR_NUMBER>}"

result=$(gh pr view "$PR_NUMBER" --json state,isDraft,mergeable,headRefName,baseRefName,title,number \
  --jq '{number: .number, title: .title, head: .headRefName, base: .baseRefName, state: .state, draft: .isDraft, mergeable: .mergeable}')

echo "$result"

state=$(echo "$result" | jq -r '.state')
draft=$(echo "$result" | jq -r '.draft')
mergeable=$(echo "$result" | jq -r '.mergeable')

if [[ "$state" == "CLOSED" || "$state" == "MERGED" ]]; then
  echo "PR #$PR_NUMBER is $state — stopping monitor" >&2
  exit 1
fi

if [[ "$draft" == "true" ]]; then
  echo "PR #$PR_NUMBER is a draft — skipping iteration" >&2
  exit 1
fi

if [[ "$mergeable" == "CONFLICTING" ]]; then
  echo "PR #$PR_NUMBER has merge conflicts — rebase required" >&2
  exit 1
fi

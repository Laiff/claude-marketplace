#!/usr/bin/env bash
# blocking-reviews.sh — List CHANGES_REQUESTED reviews on a PR
# Usage: blocking-reviews.sh <PR_NUMBER>
# Output: JSON array of {login, state, id} for blocking reviews
# Exit 0 always; empty array means no blockers
set -euo pipefail

PR_NUMBER="${1:?Usage: blocking-reviews.sh <PR_NUMBER>}"
REPO="${REPO:-$(gh repo view --json nameWithOwner --jq '.nameWithOwner')}"

gh api "repos/$REPO/pulls/$PR_NUMBER/reviews" \
  --jq '[.[] | select(.state == "CHANGES_REQUESTED") | {login: .user.login, state: .state, id: .id}]'

#!/usr/bin/env bash
# branch-freshness.sh — Check how far a branch has diverged from base
# Usage: branch-freshness.sh <BRANCH> <BASE_BRANCH>
# Output: JSON with ahead, behind counts and recommendation
set -euo pipefail

BRANCH="${1:?Usage: branch-freshness.sh <BRANCH> <BASE_BRANCH>}"
BASE="${2:?Usage: branch-freshness.sh <BRANCH> <BASE_BRANCH>}"

git fetch origin "$BASE" --quiet 2>/dev/null || true

ahead=$(git log --oneline "origin/$BASE..$BRANCH" 2>/dev/null | wc -l | tr -d ' ')
behind=$(git log --oneline "$BRANCH..origin/$BASE" 2>/dev/null | wc -l | tr -d ' ')

if [[ "$behind" -gt 5 ]]; then
  recommendation="rebase_recommended"
elif [[ "$behind" -gt 0 ]]; then
  recommendation="minor_drift"
else
  recommendation="up_to_date"
fi

jq -n \
  --arg ahead "$ahead" \
  --arg behind "$behind" \
  --arg recommendation "$recommendation" \
  '{ahead: ($ahead | tonumber), behind: ($behind | tonumber), recommendation: $recommendation}'

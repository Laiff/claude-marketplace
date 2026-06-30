#!/usr/bin/env bash
# failed-run-logs.sh — Get logs from failed CI runs on a branch
# Usage: failed-run-logs.sh <BRANCH> [TAIL_LINES]
# Output: failed run IDs + last N lines of each failed log (default 200)
#
# Only runs on the branch's CURRENT head SHA are considered, and per workflow
# name only the most recent run counts — re-runs supersede earlier failures on
# the same SHA, and failures on outdated commits are ignored.
set -euo pipefail

BRANCH="${1:?Usage: failed-run-logs.sh <BRANCH> [TAIL_LINES]}"
TAIL="${2:-200}"

runs=$(gh run list --branch "$BRANCH" --limit 30 --json databaseId,conclusion,name,headSha)

# Branch may already be deleted (merged PR) — fall back to the newest run's SHA.
head_sha=$(gh api "repos/{owner}/{repo}/branches/$BRANCH" --jq '.commit.sha' 2>/dev/null \
  || echo "$runs" | jq -r '(max_by(.databaseId) | .headSha) // empty')

run_ids=$(echo "$runs" | jq -r --arg sha "$head_sha" '
  [.[] | select(.headSha == $sha)]
  | group_by(.name)
  | map(max_by(.databaseId))
  | .[] | select(.conclusion == "failure") | .databaseId')

if [[ -z "$run_ids" ]]; then
  echo '{"runs": [], "verdict": "no_failures"}'
  exit 0
fi

while read -r run_id; do
  echo "=== RUN $run_id ==="
  gh run view "$run_id" --log-failed 2>/dev/null | tail -"$TAIL" || echo "(no log available)"
  echo ""
done <<< "$run_ids"

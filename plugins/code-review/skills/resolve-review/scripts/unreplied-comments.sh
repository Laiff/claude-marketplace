#!/usr/bin/env bash
# unreplied-comments.sh — Find root inline comments with zero replies (REST fallback)
# Usage: unreplied-comments.sh <PR_NUMBER>
# Output: one JSON object per line: {id, path, line, body_preview}
# Exit 0 always; no output means no unreplied comments
set -euo pipefail

PR_NUMBER="${1:?Usage: unreplied-comments.sh <PR_NUMBER>}"
REPO="${REPO:-$(gh repo view --json nameWithOwner --jq '.nameWithOwner')}"

all_comments=$(gh api "repos/$REPO/pulls/$PR_NUMBER/comments" --paginate)

echo "$all_comments" | jq -c '.[] | select(.in_reply_to_id == null) | .id' | while read -r id; do
  replies=$(echo "$all_comments" | jq "[.[] | select(.in_reply_to_id == $id)] | length")
  if [[ "$replies" == "0" ]]; then
    echo "$all_comments" | jq -c ".[] | select(.id == $id) | {id: .id, path: .path, line: .line, body_preview: .body[0:200]}"
  fi
done

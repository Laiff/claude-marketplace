#!/usr/bin/env bash
# review-comments.sh — Extract actionable review body comments (human + bot)
# Usage: review-comments.sh <PR_NUMBER>
# Env:   REPO=owner/name (optional, auto-detected)
# Output: JSON array of {review_id, author, state, body, is_bot, is_minimized}
#
# Returns all non-empty review body comments that may contain actionable feedback.
# Includes both human and bot reviews. The caller decides how to handle each type.
#
# Human review bodies often contain:
#   - High-level feedback/instructions in CHANGES_REQUESTED reviews
#   - Approval notes with caveats
#   - General architectural guidance
#
# Bot review bodies may contain:
#   - "Additional Findings (not in diff)" section (parsed by body-findings.sh)
#   - Summary tables and pipeline stats (informational, not actionable)
#
# This script returns the raw review data. Use body-findings.sh for structured
# extraction of bot "Additional Findings" sections specifically.
set -euo pipefail

PR_NUMBER="${1:?Usage: review-comments.sh <PR_NUMBER>}"
REPO="${REPO:-$(gh repo view --json nameWithOwner --jq '.nameWithOwner')}"
OWNER="${REPO%%/*}"
NAME="${REPO##*/}"

BOT_RE='^github-actions$|^claude-ai-|\[bot\]$|bot$'

reviews_json=$(gh api graphql \
  -F number="$PR_NUMBER" \
  -F owner="$OWNER" \
  -F name="$NAME" \
  -f query='
    query($number: Int!, $owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $number) {
          reviews(first: 100) {
            nodes {
              id
              state
              isMinimized
              author { login }
              body
            }
          }
        }
      }
    }
  ' --jq '.data.repository.pullRequest.reviews.nodes')

echo "$reviews_json" | jq -c --arg re "$BOT_RE" '[
  .[]
  | select(.body != null and (.body | length) > 0)
  | {
      review_id: .id,
      author: .author.login,
      state: .state,
      body: .body,
      is_bot: (.author.login | test($re)),
      is_minimized: .isMinimized
    }
]'

#!/usr/bin/env bash
# dismiss-resolved-reviews.sh — Minimize resolved bot review content on a PR
# Usage: dismiss-resolved-reviews.sh <PR_NUMBER>
# Env:   REPO=owner/name (optional, auto-detected)
#
# Finds all non-minimized bot review summaries (github-actions[bot]) and
# bot comments inside RESOLVED review threads, then minimizes them
# (summaries: RESOLVED/OUTDATED by review state; thread comments: RESOLVED).
# Human-authored content is never minimized.
#
# Output: JSON lines of {id, author, type, classifier, result}
set -euo pipefail

PR_NUMBER="${1:?Usage: dismiss-resolved-reviews.sh <PR_NUMBER>}"
REPO="${REPO:-$(gh repo view --json nameWithOwner --jq '.nameWithOwner')}"
OWNER="${REPO%%/*}"
NAME="${REPO##*/}"

# GraphQL returns GitHub App bot logins WITHOUT the "[bot]" suffix
# (e.g. "github-actions", not "github-actions[bot]")
BOT_RE='^github-actions$|\[bot\]$|bot$'

# Fetch all reviews and review threads with minimization state
pr_data=$(gh api graphql \
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
              bodyText
            }
          }
          reviewThreads(first: 100) {
            nodes {
              isResolved
              comments(first: 50) {
                nodes {
                  id
                  isMinimized
                  author { login }
                }
              }
            }
          }
        }
      }
    }
  ' --jq '.data.repository.pullRequest')

# Find non-minimized bot summaries with non-empty body
bot_summaries=$(echo "$pr_data" | jq -c --arg re "$BOT_RE" '[.reviews.nodes[] | select(
  .bodyText != "" and
  .isMinimized == false and
  (.author.login | test($re))
)]')

# Find non-minimized bot comments inside RESOLVED review threads
bot_thread_comments=$(echo "$pr_data" | jq -c --arg re "$BOT_RE" '[
  .reviewThreads.nodes[] | select(.isResolved == true) | .comments.nodes[] | select(
    .isMinimized == false and
    (.author.login | test($re))
  )
]')

total_count=$(jq -n --argjson a "$bot_summaries" --argjson b "$bot_thread_comments" '($a | length) + ($b | length)')

if [[ "$total_count" -eq 0 ]]; then
  echo '{"minimized": [], "skipped_human": [], "summary": "no bot summaries or resolved-thread bot comments to minimize"}'
  exit 0
fi

minimize() {
  local node_id="$1" author="$2" type="$3" classifier="$4" result
  result=$(gh api graphql \
    -F subjectId="$node_id" \
    -F classifier="$classifier" \
    -f query='
      mutation($subjectId: ID!, $classifier: ReportedContentClassifiers!) {
        minimizeComment(input: { subjectId: $subjectId, classifier: $classifier }) {
          minimizedComment { isMinimized minimizedReason }
        }
      }
    ' --jq '.data.minimizeComment.minimizedComment' 2>&1) || result='{"error": "mutation failed"}'

  echo "{\"id\": \"$node_id\", \"author\": \"$author\", \"type\": \"$type\", \"classifier\": \"$classifier\", \"result\": $result}"
}

# Minimize each bot summary (classifier by review state)
echo "$bot_summaries" | jq -c '.[]' | while read -r review; do
  node_id=$(echo "$review" | jq -r '.id')
  author=$(echo "$review" | jq -r '.author.login')
  state=$(echo "$review" | jq -r '.state')

  if [[ "$state" == "CHANGES_REQUESTED" ]]; then
    classifier="RESOLVED"
  else
    classifier="OUTDATED"
  fi

  minimize "$node_id" "$author" "summary" "$classifier"
done

# Minimize each bot comment in a resolved thread (always RESOLVED)
echo "$bot_thread_comments" | jq -c '.[]' | while read -r comment; do
  node_id=$(echo "$comment" | jq -r '.id')
  author=$(echo "$comment" | jq -r '.author.login')

  minimize "$node_id" "$author" "thread_comment" "RESOLVED"
done

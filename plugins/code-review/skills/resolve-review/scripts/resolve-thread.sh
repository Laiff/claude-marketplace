#!/usr/bin/env bash
# resolve-thread.sh — Resolve a review thread on GitHub via GraphQL
# Usage: resolve-thread.sh <THREAD_ID>
# Output: JSON with thread id and isResolved status
set -euo pipefail

THREAD_ID="${1:?Usage: resolve-thread.sh <THREAD_ID>}"

gh api graphql \
  -F threadId="$THREAD_ID" \
  -f query='
    mutation($threadId: ID!) {
      resolveReviewThread(input: { threadId: $threadId }) {
        thread { id isResolved }
      }
    }
  ' --jq '.data.resolveReviewThread.thread'

#!/usr/bin/env bash
# unresolved-threads.sh — List unresolved review threads via GraphQL
# Usage: unresolved-threads.sh <PR_NUMBER>
# Env:   REPO=owner/name (optional, auto-detected from gh repo view)
# Output: JSON array of {thread_id, path, line, author, body, reply_count}
set -euo pipefail

PR_NUMBER="${1:?Usage: unresolved-threads.sh <PR_NUMBER>}"
REPO="${REPO:-$(gh repo view --json nameWithOwner --jq '.nameWithOwner')}"
OWNER="${REPO%%/*}"
NAME="${REPO##*/}"

gh api graphql \
  -F number="$PR_NUMBER" \
  -F owner="$OWNER" \
  -F name="$NAME" \
  -f query='
    query($number: Int!, $owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $number) {
          reviewThreads(first: 100) {
            nodes {
              id
              isResolved
              comments(first: 10) {
                nodes { author { login } path line body createdAt }
              }
            }
          }
        }
      }
    }
  ' --jq '[
    .data.repository.pullRequest.reviewThreads.nodes[]
    | select(.isResolved == false)
    | {
        thread_id: .id,
        path: .comments.nodes[0].path,
        line: .comments.nodes[0].line,
        author: .comments.nodes[0].author.login,
        body: .comments.nodes[0].body,
        reply_count: (.comments.nodes | length - 1)
      }
  ]'

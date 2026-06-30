#!/usr/bin/env bash
# ci-status.sh — Check CI status for a PR
# Usage: ci-status.sh <PR_NUMBER>
# Output: JSON with pending[], failed[], skipped, summary, verdict
# Verdict: "green" | "pending" | "failed" | "no_checks"
#
# statusCheckRollup is GitHub's rollup for the PR's CURRENT HEAD commit only,
# but it retains superseded check runs when a check re-runs on the same SHA
# (e.g. "Validate PR Title" re-triggered by a title edit). We therefore dedupe
# by check name, keeping only the most recently started run, and we track
# SKIPPED/NEUTRAL conclusions separately so they never count as failed,
# pending, or part of the passed/total denominator.
set -euo pipefail

PR_NUMBER="${1:?Usage: ci-status.sh <PR_NUMBER>}"

raw=$(gh pr view "$PR_NUMBER" --json statusCheckRollup --jq '.statusCheckRollup')

# Guard: no CI checks configured or null response
if [[ -z "$raw" || "$raw" == "null" || "$raw" == "[]" ]]; then
  jq -n '{pending: [], failed: [], skipped: 0, summary: "0/0 checks (no CI configured)", verdict: "no_checks"}'
  exit 0
fi

# Normalize CheckRun and StatusContext entries to a common shape, then keep
# only the latest run per check name (max startedAt; ties broken by completedAt).
latest=$(echo "$raw" | jq -c '
  [.[] | {
    name: (.name // .context),
    status: (.status // (if (.state == "PENDING" or .state == "EXPECTED") then "PENDING" else "COMPLETED" end)),
    conclusion: (.conclusion // .state),
    ts: ((.startedAt // "") + "|" + (.completedAt // ""))
  }]
  | group_by(.name)
  | map(max_by(.ts))
  | map(del(.ts))')

pending=$(echo "$latest" | jq -c '[.[] | select(.status != "COMPLETED") | {name: .name, status: .status}]')
failed=$(echo "$latest" | jq -c '[.[] | select(.status == "COMPLETED" and (.conclusion as $c | ["SUCCESS", "SKIPPED", "NEUTRAL"] | index($c) | not)) | {name: .name, conclusion: .conclusion}]')
skipped=$(echo "$latest" | jq '[.[] | select(.conclusion == "SKIPPED" or .conclusion == "NEUTRAL")] | length')
passed=$(echo "$latest" | jq '[.[] | select(.conclusion == "SUCCESS")] | length')
total=$(echo "$latest" | jq --argjson skipped "$skipped" 'length - $skipped')

pending_count=$(echo "$pending" | jq 'length')
failed_count=$(echo "$failed" | jq 'length')

if [[ "$failed_count" -gt 0 ]]; then
  verdict="failed"
elif [[ "$pending_count" -gt 0 ]]; then
  verdict="pending"
else
  verdict="green"
fi

jq -n \
  --argjson pending "$pending" \
  --argjson failed "$failed" \
  --argjson skipped "$skipped" \
  --arg summary "${passed}/${total} checks passed (${skipped} skipped)" \
  --arg verdict "$verdict" \
  '{pending: $pending, failed: $failed, skipped: $skipped, summary: $summary, verdict: $verdict}'

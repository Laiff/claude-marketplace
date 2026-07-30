#!/usr/bin/env bash
# body-findings.sh — Extract "Additional Findings (not in diff)" from bot review bodies
# Usage: body-findings.sh <PR_NUMBER>
# Env:   REPO=owner/name (optional, auto-detected)
# Output: JSON array of {review_id, author, finding_type, file, line, description, review_state}
#
# Parses the review body markdown for the "Additional Findings" section, extracting
# each finding's type, file, approximate line, and description. Only processes
# non-minimized bot reviews that have a body containing "Additional Findings".
set -euo pipefail

PR_NUMBER="${1:?Usage: body-findings.sh <PR_NUMBER>}"
REPO="${REPO:-$(gh repo view --json nameWithOwner --jq '.nameWithOwner')}"
OWNER="${REPO%%/*}"
NAME="${REPO##*/}"

# GraphQL returns bot logins WITHOUT "[bot]" suffix
BOT_RE='^github-actions$|\[bot\]$|bot$'

# Fetch all reviews with body text and minimization state
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

# Filter: non-minimized bot reviews with "Additional Findings" in body
bot_reviews_with_findings=$(echo "$reviews_json" | jq -c --arg re "$BOT_RE" '[
  .[] | select(
    .isMinimized == false and
    (.author.login | test($re)) and
    (.body | test("Additional Findings"))
  )
]')

count=$(echo "$bot_reviews_with_findings" | jq 'length')

if [[ "$count" -eq 0 ]]; then
  echo '[]'
  exit 0
fi

# Parse each review body to extract individual findings from the "Additional Findings" section
# Expected markdown format:
#   ### Additional Findings (not in diff)
#
#   **[TYPE] Category** — `path/to/file.ext` (~line N)
#   Description of the finding...
#
# We extract: finding_type (e.g. "NORM"), category, file path, approximate line, description
echo "$bot_reviews_with_findings" | jq -c '.[]' | while read -r review; do
  review_id=$(echo "$review" | jq -r '.id')
  author=$(echo "$review" | jq -r '.author.login')
  state=$(echo "$review" | jq -r '.state')
  body=$(echo "$review" | jq -r '.body')

  # Extract the "Additional Findings" section (everything after the header until next ## or end)
  additional_section=$(echo "$body" | sed -n '/^### Additional Findings/,/^##[^#]/p' | head -n -1)
  if [[ -z "$additional_section" ]]; then
    # Try without leading ### (some reviews use ##)
    additional_section=$(echo "$body" | sed -n '/^## Additional Findings/,/^##[^#]/p' | head -n -1)
  fi
  if [[ -z "$additional_section" ]]; then
    continue
  fi

  # Parse finding lines: **[TYPE] Category** — `file` (~line N)
  # Followed by description text on subsequent lines until next finding or end
  echo "$additional_section" | python3 -c "
import sys, json, re

lines = sys.stdin.read().strip().split('\n')
findings = []
current = None

# Pattern: **[SEVERITY] Category** — \`path/to/file\` (~line N)
# or:      **[SEVERITY] Category** -- \`path/to/file\` (~line N)
pattern = re.compile(
    r'\*\*\[(\w+)\]\s+(\w+)\*\*\s*[—–\-]+\s*\x60([^\x60]+)\x60\s*\(~line\s*(\d+)\)'
)

for line in lines:
    m = pattern.search(line)
    if m:
        if current:
            findings.append(current)
        current = {
            'review_id': '$review_id',
            'author': '$author',
            'review_state': '$state',
            'finding_type': m.group(1),
            'category': m.group(2),
            'file': m.group(3),
            'line': int(m.group(4)),
            'description': ''
        }
    elif current and line.strip() and not line.startswith('### '):
        if current['description']:
            current['description'] += ' '
        current['description'] += line.strip()

if current:
    findings.append(current)

for f in findings:
    print(json.dumps(f))
"
done | jq -s '.'

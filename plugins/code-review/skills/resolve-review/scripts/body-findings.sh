#!/usr/bin/env bash
# body-findings.sh — Extract "Additional Findings (not in diff)" from bot review bodies
# Usage: body-findings.sh <PR_NUMBER>
# Env:   REPO=owner/name (optional, auto-detected)
# Output: JSON array of {review_id, author, finding_type, category, file, line, description, review_state, is_minimized}
#
# Parses the review body markdown for "Additional Findings" sections, extracting
# each finding's severity, category, file(s), approximate line(s), and description.
# Processes ALL bot reviews (including minimized) because body findings may have
# never been addressed before the review was minimized.
set -euo pipefail

PR_NUMBER="${1:?Usage: body-findings.sh <PR_NUMBER>}"
REPO="${REPO:-$(gh repo view --json nameWithOwner --jq '.nameWithOwner')}"
OWNER="${REPO%%/*}"
NAME="${REPO##*/}"

# Fetch all reviews via GraphQL (body as raw markdown)
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

# Filter to bot reviews containing "Additional Findings".
# Includes minimized reviews — body findings may not have been addressed before
# the review was minimized.
#
# Bot detection: GitHub App logins are returned WITHOUT "[bot]" suffix by GraphQL.
filtered=$(echo "$reviews_json" | jq -c '[
  .[] | select(
    ((.author.login // "") | test("^github-actions$|^claude-ai-|\\[bot\\]$|bot$")) and
    ((.body // "") | test("Additional Findings"))
  )
]')

count=$(echo "$filtered" | jq 'length')
if [[ "$count" -eq 0 ]]; then
  echo '[]'
  exit 0
fi

# All parsing in a single Python call — no shell interpolation of review content
echo "$filtered" | python3 -c '
import sys, json, re

reviews = json.load(sys.stdin)
findings = []

# Real-world format variants observed across PRs:
#
# A) **[ARCH] Missing env var documentation** — `file.ts` (~line 123)
#    Standard: severity + description, separator, file, line
#
# B) **[NORM] Convention — `file.ts` (~lines 20–42)**
#    Closing ** wraps entire line; "~lines" plural with range
#
# C) **[CONV] Missing tests for 5 new S2S endpoints**
#    No file/line — batched finding about multiple files listed in body
#
# D) **[NIT] Convention — Missing `logRequest`/`logResponse` in all 5 files**
#    No (~line N) — affected files listed inline in body text
#
# Strategy: match the bold-bracket header **[SEV] ...** and extract what we can.
# File and line are optional — some findings span multiple files.

# Pattern 1: has file ref with (~line N) or (~lines N–M)
#   **[SEV] text** — `file` (~line N)
#   **[SEV] text — `file` (~line N)**
#   **[SEV] text — `file` (~lines N–M)**
PAT_WITH_FILE_LINE = re.compile(
    r"\*\*\[(\w+)\]\s+"              # **[SEVERITY]<space>
    r"(.+?)"                          # category/description (lazy)
    r"\*{0,2}"                        # optional closing ** before separator
    r"\s*(?:—|–|--|-)\s*"            # separator
    r"`([^`]+)`"                      # `file`
    r"\s*"
    r"\(~lines?\s*(\d+)"             # (~line N  or  (~lines N
    r"(?:[–\-]\d+)?"                 # optional –M range end
    r"\)\*{0,2}"                      # closing )  with optional trailing **
)

# Pattern 2: has file ref but no line number
#   **[SEV] text — `file`**
#   **[SEV] text** — `file`
PAT_WITH_FILE = re.compile(
    r"\*\*\[(\w+)\]\s+"
    r"(.+?)"
    r"\*{0,2}"
    r"\s*(?:—|–|--|-)\s*"
    r"`([^`]+)`"
    r"\*{0,2}"
)

# Pattern 3: no file ref at all (batched/multi-file findings)
#   **[SEV] Description text**
PAT_HEADER_ONLY = re.compile(
    r"\*\*\[(\w+)\]\s+"
    r"(.+?)"
    r"\*{2}"                          # must end with **
)

# Section headers
SECTION_RE = re.compile(r"^#{2,3}\s+")

# Inline file references in body text
# Prefer: `path/to/file.ts` (~line N)  — has line number
# Fallback: `path/to/file.ts`          — no line number
INLINE_FILE_WITH_LINE_RE = re.compile(
    r"`([^`]+\.\w+)`"                # `file.ext`
    r"\s*\(~lines?\s*(\d+)"          # (~line N)
    r"(?:[–\-]\d+)?\)"               # optional range
)
INLINE_FILE_BARE_RE = re.compile(
    r"`([^`]+/[^`]+\.\w+)`"          # `path/to/file.ext` (require /)
)

def match_finding_header(line):
    """Try patterns in order of specificity. Return dict or None."""
    m = PAT_WITH_FILE_LINE.search(line)
    if m:
        return {
            "finding_type": m.group(1),
            "category": m.group(2).rstrip("* "),
            "file": m.group(3),
            "line": int(m.group(4)),
        }

    m = PAT_WITH_FILE.search(line)
    if m:
        return {
            "finding_type": m.group(1),
            "category": m.group(2).rstrip("* "),
            "file": m.group(3),
            "line": 0,
        }

    m = PAT_HEADER_ONLY.search(line)
    if m:
        return {
            "finding_type": m.group(1),
            "category": m.group(2).rstrip("* "),
            "file": "",
            "line": 0,
        }

    return None

def extract_inline_files(text):
    """Extract file references from description body text.
    Prefers refs with line numbers; falls back to bare file paths."""
    files = []
    seen = set()
    # First pass: files with (~line N)
    for m in INLINE_FILE_WITH_LINE_RE.finditer(text):
        f = m.group(1)
        if f not in seen:
            seen.add(f)
            files.append({"file": f, "line": int(m.group(2))})
    # Second pass: bare file paths (no line number)
    for m in INLINE_FILE_BARE_RE.finditer(text):
        f = m.group(1)
        if f not in seen:
            seen.add(f)
            files.append({"file": f, "line": 0})
    return files

for review in reviews:
    review_id = review.get("id", "")
    author = review.get("author", {}).get("login", "")
    state = review.get("state", "")
    is_minimized = review.get("isMinimized", False)
    body = review.get("body") or ""

    lines = body.split("\n")
    in_section = False
    current = None

    for line in lines:
        # Detect section boundaries
        if SECTION_RE.match(line):
            if "Additional Findings" in line:
                in_section = True
                continue
            elif in_section:
                # Hit next section — flush and stop
                break

        if not in_section:
            continue

        # Skip horizontal rules and blank pipeline summaries
        stripped = line.strip()
        if stripped.startswith("---") and len(stripped) <= 5:
            continue
        if stripped.startswith("Pipeline:"):
            continue

        # Try to match a finding header
        header = match_finding_header(line)
        if header:
            # Save previous finding
            if current:
                current["description"] = current["description"].strip()
                # For multi-file findings with no file in header,
                # extract first inline file reference from description
                if not current["file"] and current["description"]:
                    inline_files = extract_inline_files(current["description"])
                    if inline_files:
                        current["file"] = inline_files[0]["file"]
                        current["line"] = inline_files[0]["line"]
                        current["affected_files"] = [f["file"] for f in inline_files]
                findings.append(current)

            current = {
                "review_id": review_id,
                "author": author,
                "review_state": state,
                "is_minimized": is_minimized,
                "finding_type": header["finding_type"],
                "category": header["category"],
                "file": header["file"],
                "line": header["line"],
                "description": "",
            }
        elif current:
            if stripped:
                if current["description"]:
                    current["description"] += " "
                current["description"] += stripped

    # Flush last finding
    if current:
        current["description"] = current["description"].strip()
        if not current["file"] and current["description"]:
            inline_files = extract_inline_files(current["description"])
            if inline_files:
                current["file"] = inline_files[0]["file"]
                current["line"] = inline_files[0]["line"]
                current["affected_files"] = [f["file"] for f in inline_files]
        findings.append(current)

json.dump(findings, sys.stdout, ensure_ascii=False)
print()
'

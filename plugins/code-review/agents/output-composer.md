---
model: sonnet
description: "Compose and post the final review — terminal summary and single atomic review"
tools: Read, Write, Bash(gh pr review:*), Bash(gh api:*), Bash(python3:*), Bash(cat:*)
---

# Output Composer Agent

Take the validated, deduplicated, budget-constrained findings and produce the
final review output: terminal summary and a single atomic GitHub review.

## Input

You receive as YAML from the orchestrator:
- Final list of findings (from Phase 4 processing)
- Review verdict with classification (from dedup-orchestrator) — see `skills/code-review/protocols/review-verdict.md`
- Pipeline stats (from dedup-orchestrator)
- PR summary (from pr-summarizer)
- Whether `--post` flag was provided (controls whether to post to GitHub)
- Prior verification results (from Phase 2, when is_fix_verification is true) — for rendering the verification table

For head SHA, repo, and PR number: read `./.claude-review-context/context.yaml` (structured envelope).
For inlineability checks: read `./.claude-review-context/file_patches.json` (pre-fetched patches).

### Flag vs Verdict — CRITICAL DISTINCTION

- **`--post` flag** controls WHETHER to post to GitHub (on = post, off = terminal only)
- **`verdict.action`** controls the review EVENT TYPE (APPROVE / REQUEST_CHANGES / COMMENT)

These are independent. `--post` does NOT influence the review event type.
The verdict is always determined by Phase 4 based on findings.

## Step 1: Terminal Summary (ALWAYS)

Output a summary to the terminal regardless of `--post` flag.
Include the verdict action and classification in the header.

If findings exist:
```
## Code Review — :shield: Security — Request Changes

Found N issues: X bugs, Y convention violations, Z security issues.
Verdict: REQUEST_CHANGES — "1 CRIT security finding (SQL injection in auth route)"

| # | Type | Severity | File | Description | Confidence |
|---|------|----------|------|-------------|------------|
| 1 | SEC | CRIT | path/auth.ts:L15 | SQL injection | 95 |
| 2 | CONV | NIT | path/file.tsx:L88 | Missing autodocs | 90 |
```

If no findings:
```
## Code Review — :white_check_mark: Clean — Approved

No issues found. Reviewed N files for bugs, CLAUDE.md compliance, and security.
Verdict: APPROVE
```

If fix-verification with all prior findings fixed:
```
## Code Review — :white_check_mark: Fix Verified — Approved

All prior findings verified as fixed. No new issues found. Reviewed N files for bugs, CLAUDE.md compliance, and security.

### Prior Findings Verification

| # | Status | File | Prior Issue | Verification |
|---|--------|------|-------------|--------------|
| 1 | :white_check_mark: Fixed | `file.tsx:L42` | Description of prior finding | What changed to fix it |

Pipeline: Phase 2 produced 0 new findings | Prior verification: N/N fixed → Verdict: APPROVE (V7+FV)
```

If fix-verification with unfixed prior findings:
```
## Code Review — :mag: Fix Incomplete — Comment

0 new issues found, but N prior findings remain unresolved.

### Prior Findings Verification

| # | Status | File | Prior Issue | Verification |
|---|--------|------|-------------|--------------|
| 1 | :x: Not Fixed | `file.tsx:L42` | Description of prior finding | What was NOT addressed |
| 2 | :white_check_mark: Fixed | `file.tsx:L88` | Description of prior finding | What changed to fix it |

Pipeline: Phase 2 produced 0 new findings | Prior verification: M/N fixed → Verdict: COMMENT (unfixed prior findings)
```

Classification icons:
- `:shield:` security | `:bug:` bugs | `:memo:` conventions
- `:building_construction:` architecture | `:mag:` mixed | `:white_check_mark:` clean

Verdict labels:
- `APPROVE` -> "Approved" | `REQUEST_CHANGES` -> "Request Changes" | `COMMENT` -> "Comment"

Always append the pipeline summary:
```
Pipeline: Phase 2 produced N findings -> Phase 3 validated M -> Phase 4 deduped to K
```

## Step 2: Post Review (only with --post flag)

If `--post` was NOT provided, stop after terminal summary.

### Pre-post Validation

For EACH finding about to be posted, verify:
1. Body length >= 20 characters (Guard G1)
2. Body does NOT match `/^(test|\s*)$/i` (Guard G1)
3. No existing comment with >80% similarity on same (path, line) (Guard G3)

Drop any finding that fails pre-post validation.

### Classify Findings by Postability

Split findings into two groups:

**Inlineable** — finding line is inside a diff hunk (can be posted as inline review comment):
- Check against `./.claude-review-context/file_patches.json` if available
- Or parse hunk headers from `./.claude-review-context/diff.txt`
- A line is inlineable if it appears as a `+` or context line in any hunk of the PR diff

**Non-inlineable** — finding line is NOT in the diff (e.g., unchanged code, batched findings):
- These go into the review **body** as a "Additional findings" section
- Do NOT post these as separate PR comments

### Compose Inline Comments

For each **inlineable** finding, format the comment body:

```markdown
**{description}**

[`path/to/CLAUDE.md`](https://github.com/{owner}/{repo}/blob/{SHA}/path/CLAUDE.md) Convention N: *"rule text"*

```suggestion
fixed code here
```
```

Rules for suggestion blocks:
- Only include `suggestion` if `suggestion_type` is "code"
- Only if the fix is < 6 lines and self-contained
- NEVER post a suggestion unless committing it entirely fixes the issue
- If the fix is larger, describe it in prose
- The suggestion block REPLACES the line at the comment's `line` number.
  If the suggestion text does not match that exact line, REMOVE the suggestion
  block and describe the fix in prose instead.

**For batched findings** (batch_key is set):
- Include in the review body under "Additional findings", listing all affected files
- Do NOT post as a separate PR comment

### Compose Review Body

Build a single review body that includes:
1. Classification header: `## Code Review — {icon} {classification} — {verdict_label}`
2. Verdict reasoning
3. Finding summary table (all findings, both inline and non-inlineable)
4. **Non-inlineable findings section** (if any findings couldn't be posted inline):
   ```markdown
   ### Additional Findings (not in diff)

   **[NORM] Convention** — `.github/workflows/file.yml` (~line 12)
   Description of the finding...
   ```
5. Pipeline stats: `Phase 2 produced N -> Phase 3 validated M -> Phase 4 deduped to K`

This review body is the ONLY summary. Do NOT post a separate summary comment.

### Line Integrity Rule (MANDATORY)

Each inline comment uses the finding's `line` field (the file line number set by Phase 2)
as the comment anchor. This rule prevents suggestions from attaching to wrong lines.

1. **NEVER relocate a comment to a different line.** The `line` field from the finding
   is the ONLY valid anchor. Do not manually pick a "more representative" line.
2. **If a `suggestion` block is present**, the comment `line` MUST be the exact line
   the suggestion replaces. If the finding's `line` does not match the suggestion target,
   REMOVE the `suggestion` block and use prose instead.
3. **If the finding's `line` is not in the diff** (not a `+` or context line),
   move the entire finding to the review body ("Additional Findings" section).
   Do NOT guess a nearby inlineable line.

### Posting — Single Atomic Review

Post exactly ONE GitHub review combining verdict + inline comments + body.
The `event` field is determined by `verdict.action`.

**Map verdict to GitHub review event:**
- `APPROVE` -> event: `APPROVE`, flag: `--approve`
- `REQUEST_CHANGES` -> event: `REQUEST_CHANGES`, flag: `--request-changes`
- `COMMENT` -> event: `COMMENT`, flag: `--comment`

**Inline comments use the `line` + `side` fields (NOT the legacy `position` field).**
The `line` field is the file line number on the RIGHT side of the diff — this is exactly
the finding's `line` field. No diff-position computation is needed.

**Method 1 — gh api POST (preferred — atomic):**
```bash
# Build payload.json:
# {
#   "commit_id": "<head_sha>",
#   "event": "REQUEST_CHANGES",
#   "body": "## Code Review — :shield: Security — Request Changes\n\n...",
#   "comments": [
#     {"path": "file.ts", "line": 15, "side": "RIGHT", "body": "..."}
#   ]
# }
gh api repos/{owner}/{repo}/pulls/{number}/reviews \
  --method POST --input ./.claude-review-context/review_payload.json
```

Each comment object MUST have:
- `path` — file path relative to repo root (from finding's `file` field)
- `line` — file line number (from finding's `line` field, NEVER modified)
- `side` — always `"RIGHT"` (we comment on the new version of the file)
- `body` — the formatted comment text

Do NOT include the `position` field. The `line` + `side` API is the modern
replacement and does not require diff-position arithmetic.

For multi-line comments (finding has `end_line`):
```json
{"path": "file.ts", "line": 45, "start_line": 42, "start_side": "RIGHT", "side": "RIGHT", "body": "..."}
```

**Method 2 — Python utility fallback:**
```bash
python3 ./.claude-review-context/post_review.py ./.claude-review-context/review_payload.json {owner/repo} {number}
```

**Method 3 — gh pr review fallback (verdict only, no inline comments):**
```bash
gh pr review {number} --repo {owner/repo} --approve --body-file ./.claude-review-context/review_payload.json
gh pr review {number} --repo {owner/repo} --request-changes --body-file ./.claude-review-context/review_payload.json
gh pr review {number} --repo {owner/repo} --comment --body-file ./.claude-review-context/review_payload.json
```

### Output Rules

- **ONE review** — never post more than one GitHub review event per pipeline run
- **ZERO separate comments** — no `gh pr comment` calls. Everything goes in the review body or as inline comments within the review
- **Non-inlineable findings in body** — if a finding can't be an inline comment, include it in the review body text

## Step 3: Capture Feedback Signals

Log these metrics for the feedback-learner pipeline:
- Total findings generated (Phase 2 count from stats)
- Findings surviving validation (Phase 3)
- Batch consolidation count
- Budget trimming count
- Finding category distribution
- Which guards triggered
- **Verdict action** (APPROVE, REQUEST_CHANGES, COMMENT)
- **Review classification** (security, bugs, conventions, architecture, mixed, clean)
- **Verdict rule applied** (V1-V7)
- **Calibration guards triggered** (VC1-VC5)
- **Prior verification results** (fixed/not_fixed/partially_fixed counts, when is_fix_verification)
- **Fix-verification verdict override** (whether V7 was overridden to COMMENT due to unfixed prior findings)

## Link Format

When linking to code in comments, use this EXACT format:
```
https://github.com/{owner}/{repo}/blob/{FULL_SHA}/path/file.ext#L10-L15
```
- Full 40-character SHA (not abbreviated)
- `#L` notation with line range
- Include at least 1 line of context before and after

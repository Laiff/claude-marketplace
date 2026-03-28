---
model: sonnet
description: "Compose and post the final review — terminal summary, inline comments, PR summary"
tools: Read, Write, Bash(gh pr comment:*), Bash(gh pr review:*), Bash(gh api:*), Bash(python3:*), Bash(cat:*)
---

# Output Composer Agent

Take the validated, deduplicated, budget-constrained findings and produce the
final review output: terminal summary, inline comments, and PR summary.

## Input

You receive as YAML from the orchestrator:
- Final list of findings (from Phase 4 processing)
- Review verdict with classification (from dedup-orchestrator) — see `protocols/review-verdict.md`
- Pipeline stats (from dedup-orchestrator)
- PR summary (from pr-summarizer)
- Head SHA (for permalink URLs)
- Repository name (owner/repo)
- PR number
- Whether `--comment` flag was provided

## Step 1: Terminal Summary (ALWAYS)

Output a summary to the terminal regardless of `--comment` flag.
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

Classification icons:
- `:shield:` security | `:bug:` bugs | `:memo:` conventions
- `:building_construction:` architecture | `:mag:` mixed | `:white_check_mark:` clean

Verdict labels:
- `APPROVE` -> "Approved" | `REQUEST_CHANGES` -> "Request Changes" | `COMMENT` -> "Comment"

Always append the pipeline summary:
```
Pipeline: Phase 2 produced N findings -> Phase 3 validated M -> Phase 4 deduped to K
```

## Step 2: Post Comments (only with --comment flag)

If `--comment` was NOT provided, stop here.

### Pre-post Validation

For EACH finding about to be posted, verify:
1. Body length >= 20 characters (Guard G1)
2. Body does NOT match `/^(test|\s*)$/i` (Guard G1)
3. Line number is in the PR diff (Guard G2)
4. No existing comment with >80% similarity on same (path, line) (Guard G3)

Drop any finding that fails pre-post validation.

### Compose Inline Comments

For each finding, format the comment body:

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

**For batched findings** (batch_key is set):
```markdown
**[Convention violation]** — Found in N files

Convention N: *"rule text"* from [`CLAUDE.md`](link)

Affected files:
- `file1.tsx` (line 42)
- `file2.tsx` (line 15)
- `file3.tsx` (line 88)
```
Post this as a single PR-level comment, NOT inline.

### Posting Fallback Chain

Try each method in order, move to next on failure.
The `event` field and `gh pr review` flag are determined by `verdict.action`.

**Map verdict to GitHub review event:**
- `APPROVE` -> event: `APPROVE`, flag: `--approve`
- `REQUEST_CHANGES` -> event: `REQUEST_CHANGES`, flag: `--request-changes`
- `COMMENT` -> event: `COMMENT`, flag: `--comment`

1. **gh api POST (preferred — atomic verdict + inline comments):**
   ```bash
   # Build payload.json with verdict event and inline comments
   # {
   #   "event": "REQUEST_CHANGES",  <-- from verdict.action
   #   "body": "## Code Review — :shield: Security\n\n...",
   #   "comments": [{"path": "...", "line": N, "body": "..."}]
   # }
   gh api repos/{owner}/{repo}/pulls/{number}/reviews \
     --method POST --input payload.json
   ```

2. **Python utility (if available):**
   ```bash
   python3 .claude-review-context/post_review.py payload.json {owner/repo} {number}
   ```

3. **gh pr review fallback (verdict only, no inline comments):**
   ```bash
   # APPROVE
   gh pr review {number} --repo {owner/repo} --approve --body-file review.md

   # REQUEST_CHANGES
   gh pr review {number} --repo {owner/repo} --request-changes --body-file review.md

   # COMMENT (default fallback)
   gh pr review {number} --repo {owner/repo} --comment --body-file review.md
   ```

**Important:** When using fallback method 3, inline comments cannot be posted atomically
with the verdict. Post them separately via `gh api` individual comment calls, then
post the verdict review.

### Summary Comment

After the review (with verdict), post ONE summary comment with classification:
```bash
gh pr comment {number} --repo {owner/repo} --body-file summary.md
```

The summary comment body should include:
- Classification icon and label
- Verdict action and reasoning
- Finding table (if any)
- Pipeline stats

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

## Link Format

When linking to code in comments, use this EXACT format:
```
https://github.com/{owner}/{repo}/blob/{FULL_SHA}/path/file.ext#L10-L15
```
- Full 40-character SHA (not abbreviated)
- `#L` notation with line range
- Include at least 1 line of context before and after

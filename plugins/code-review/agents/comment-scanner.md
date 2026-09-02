---
model: haiku
description: "Scan existing review comments to build dedup index and prevent re-posting"
tools: Read, Bash(gh api:*), Bash(gh pr view:*)
---

# Comment Scanner Agent

Check for existing review comments on this PR from previous bot runs.
This data is used by the dedup guard (G3) to prevent re-posting.

## Steps

1. Check for pre-fetched review history (PREFERRED — avoids ALL API calls):
   - Read `<pwd>/.claude-review-context/prior_reviews.yaml` — contains review threads with
     paths, lines, conversation bodies, reactions, resolution status, and signal classification
   - This file is produced by a GraphQL fetch + signal classifier in the CI workflow
   - Each thread already has a `signal` field: `accepted`, `rejected`, `pending`, `empty`, `resolved`

2. If `prior_reviews.yaml` is NOT available, fall back to API:
   ```bash
   # Review events (APPROVE, REQUEST_CHANGES, COMMENT) — commit_id is stable
   gh api repos/{owner}/{repo}/pulls/{number}/reviews \
     --jq '.[] | {id, state, commit_id, body: .body[:100], user: .user.login, submitted_at}'

   # Inline review comments — use original_commit_id (not commit_id, which shifts)
   gh api repos/{owner}/{repo}/pulls/{number}/comments \
     --jq '.[] | {id, path, line: .original_line, original_commit_id, body: .body[:100], user: .user.login, created_at}'
   ```
   ```bash
   # PR-level issue comments
   gh api repos/{owner}/{repo}/issues/{number}/comments \
     --jq '.[] | {id, body: .body[:100], user: .user.login, created_at}'
   ```

   **CRITICAL:** When using the comments endpoint, always use `original_commit_id`
   (not `commit_id`) to determine which push a comment belongs to. GitHub updates
   `commit_id` as new commits arrive, making old comments appear current.

   **Filter out junk:** Ignore bot comments with body matching `/^(test|\s*)$/i`
   or body length < 20 chars — these are G1 noise from broken runs.

3. From either source, extract bot comments and build dedup index

4. Build a deduplication index

## Output

Return your results as a YAML block:

```yaml
existing_comments:
  inline:
    - path: "src/file.tsx"
      line: 42
      body_preview: "First 100 chars of the comment..."
      signal: rejected          # from prior_reviews.yaml signal classification
  pr_level:
    - body_preview: "## Code review\n\nFound 2 issues..."
      signal: accepted
  dedup_keys:
    - "src/file.tsx:42:convention-violation"
    - "src/other.tsx:88:bug-report"
  has_prior_review: true
  prior_review_signals:
    accepted: 3
    rejected: 1
    pending: 0
  prior_bot_review_body: |
    ## Full text of the most recent bot review body
    This is essential for fix-verification scenarios (Guard G11).
    Phase 2 agents need the complete prior review to understand
    what was accepted, recommended, and flagged.
  prior_bot_review_commit: "abc123..."
```

### Prior review body preservation (Guard G11)

**CRITICAL for fix-verification scenarios**: When a prior bot review exists
(from `github-actions[bot]` or `claude-ai-review[bot]`), 
you MUST preserve the **complete review body text** in `prior_bot_review_body`. 
Do NOT truncate to a snippet.

Phase 2 agents need the full text to:
- Understand what the prior review explicitly accepted or did not flag
- Know what specific fix was recommended
- Avoid contradicting the prior review's recommendations

If the body exceeds 2000 characters, preserve the first 2000 characters — this is
still far more useful than an 80-char snippet.

Also preserve `prior_bot_review_commit` — the commit SHA the prior review was
submitted against. This lets Phase 2 agents distinguish code that was already
reviewed from new code in the fix commit.

## Communication rules

- `dedup_keys` are normalized as `path:line:description_first_30_chars_lowercase`
- Phase 4 (dedup) compares new findings against these keys
- If `has_prior_review` is true, only post findings for NEW or CHANGED issues
- `prior_bot_review_body` must contain the FULL body (up to 2000 chars) of the
  most recent bot review — not just a snippet. This is mandatory for G11 compliance.
- Use YAML format for all structured output

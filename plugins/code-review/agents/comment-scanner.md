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
   - Read `.claude-review-context/prior_reviews.yaml` — contains review threads with
     paths, lines, conversation bodies, reactions, resolution status, and signal classification
   - This file is produced by a GraphQL fetch + signal classifier in the CI workflow
   - Each thread already has a `signal` field: `accepted`, `rejected`, `pending`, `empty`, `resolved`

2. If `prior_reviews.yaml` is NOT available, fall back to API:
   ```bash
   gh api repos/{owner}/{repo}/pulls/{number}/comments \
     --jq '.[] | {id, path, line: .original_line, body: .body[:100], user: .user.login, created_at}'
   ```
   ```bash
   gh api repos/{owner}/{repo}/issues/{number}/comments \
     --jq '.[] | {id, body: .body[:100], user: .user.login, created_at}'
   ```

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
```

## Communication rules

- `dedup_keys` are normalized as `path:line:description_first_30_chars_lowercase`
- Phase 4 (dedup) compares new findings against these keys
- If `has_prior_review` is true, only post findings for NEW or CHANGED issues
- Use YAML format for all structured output

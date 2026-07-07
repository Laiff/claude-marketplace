---
model: haiku
description: "Summarize the PR for review agents — intent, scope, risk areas"
tools: Read, Bash(gh pr view:*), Bash(gh pr diff:*)
---

# PR Summarizer Agent

Produce a structured summary of the PR that gives review agents the context they need
to understand the INTENT behind the changes, not just the mechanics.

## Steps

1. Read PR metadata:
   - **ALWAYS try `./.claude-review-context/pr_meta.yaml` FIRST** (YAML format, pre-fetched)
   - Only fall back to `gh pr view` if the file does not exist or is empty

2. Read the diff:
   - **ALWAYS try `./.claude-review-context/diff.txt` FIRST** (pre-fetched)
   - Only fall back to `gh pr diff` if the file does not exist or is empty

3. Read prior review context:
   - **ALWAYS try `./.claude-review-context/prior_reviews.yaml` FIRST** (pre-fetched)
   - Use this to detect fix-verification scenarios and extract prior findings
   - Only fall back to `gh api` if the file does not exist

4. Analyze and produce summary

## Output

Return your results as a YAML block:

```yaml
pr_summary:
  title: "PR title"
  intent: "2-3 sentence description of what the PR aims to achieve"
  type: feature          # feature | bugfix | refactor | docs | test | chore | mixed
  scope: "Which part of the system this affects"
  additions: 1234
  deletions: 567
  files_changed: 14
  file_groups:
    turbo/packages/ds/src/stories/:
      - "file1.tsx"
      - "file2.tsx"
    turbo/apps/api/src/:
      - "route.ts"
  key_changes:
    - "Added new React component DecisionDetail with voting UI"
    - "Updated Storybook stories for decision framework"
  risk_areas:
    - "Large component (1400 lines) — may have complexity issues"
    - "New mock data — verify type safety"
  head_sha: "abc123def456..."
  is_fix_verification: false
  prior_review_commit: null        # SHA of the commit the prior bot review was against
  prior_findings:                  # list of prior bot review findings (from prior_reviews.yaml)
    - "Description of what the prior review flagged"
  prior_accepted:                  # items the prior review saw but did NOT flag
    - "Description of items implicitly accepted by the prior review"
```

### Fix-verification detection

Check if this is a fix-verification scenario:
- Read `./.claude-review-context/prior_reviews.yaml` (or use preflight output)
- If a prior bot review exists on an OLDER commit (different SHA than current HEAD):
  - Set `is_fix_verification: true`
  - Set `prior_review_commit` to the prior review's commit SHA
  - Extract the prior review's specific findings into `prior_findings`
  - List items the prior review explicitly mentioned as covered/acceptable in `prior_accepted`
    (e.g., "prior review listed ^1, ^2, ^4, ^5 as covered — these are accepted")

This context is critical for Phase 2 agents to apply Guard G11 (prior review consistency).

## Communication rules

- `intent` should capture WHY, not just WHAT — review agents use this to avoid flagging intentional patterns
- `risk_areas` should flag things worth extra scrutiny by bug-detector and security-reviewer
- `file_groups` help the batch guard identify related files
- `head_sha` is needed for creating GitHub permalink URLs in comments
- `is_fix_verification`, `prior_findings`, and `prior_accepted` are critical for Guard G11
- Use YAML format for all structured output
- **Do NOT call `gh pr view` or `gh pr diff` if pre-fetched data exists** — see cost optimization rules

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
   - If `.claude-review-context/pr_meta.yaml` exists, use it (YAML format)
   - Otherwise: `gh pr view {number} --repo {owner/repo} --json title,body,files,additions,deletions`

2. Read the diff:
   - If `.claude-review-context/diff.txt` exists, use it
   - Otherwise: `gh pr diff {number} --repo {owner/repo}`

3. Analyze and produce summary

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
```

## Communication rules

- `intent` should capture WHY, not just WHAT — review agents use this to avoid flagging intentional patterns
- `risk_areas` should flag things worth extra scrutiny by bug-detector and security-reviewer
- `file_groups` help the batch guard identify related files
- `head_sha` is needed for creating GitHub permalink URLs in comments
- Use YAML format for all structured output

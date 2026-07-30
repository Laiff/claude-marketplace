# Review Comment Classification Guide

## Core Principle: REVIEWER MAY BE WRONG

Treat every review comment as a hypothesis to verify, not an instruction to follow blindly. The reviewer sees a snapshot; the agent has full diff context, gate file design decisions, and project conventions.

## Processing Priority

Address comments in this order — bugs first, style last:

1. Valid bug
2. Valid convention
3. Valid improvement
4. Stale comment
5. Duplicate
6. Already handled
7. Out of scope
8. False positive
9. Preference/style

## Classification Table

### Valid bug
- **Criteria:** Code is objectively incorrect — will cause runtime failure, data corruption, or security issue
- **Action:** Fix in code, reply confirming fix, resolve thread
- **Reply format:** "Fixed in `abc1234`. [1-line description]."

### Valid convention
- **Criteria:** Violates project conventions (CLAUDE.md, turbo/CLAUDE.md, eslint, design patterns)
- **Action:** Fix in code, reply confirming fix, resolve thread
- **Reply format:** "Fixed in `abc1234`. [1-line description]."

### Valid improvement
- **Criteria:** Genuinely improves code quality AND is in scope of this PR
- **Action:** Fix in code, reply confirming fix, resolve thread
- **Reply format:** "Fixed in `abc1234`. [1-line description]."

### Stale comment
- **Criteria:** The referenced code at path:line was changed or removed in a later commit on this PR
- **Verification:** Check `git log --oneline -- <path>` to see if the file was modified after the comment timestamp
- **Action:** Reply with evidence, resolve thread
- **Reply format:** "Addressed in `abc1234` which changed `file:line`."

### Duplicate
- **Criteria:** Same logical concern already raised on another thread (detect by similar body text targeting the same code pattern)
- **Action:** Fix once, reply on ALL duplicate threads referencing the same commit, resolve all
- **Reply format:** "Same issue as [other thread] — fixed in `abc1234`."

### Already handled
- **Criteria:** The concern is already addressed — code already does what reviewer asks, or issue is tracked in `human_review_flags` section of gate file
- **Action:** Reply with evidence, resolve thread
- **Reply format:** "Already covered: [evidence]. See `file:line` / gate file section."

### Out of scope
- **Criteria:** Valid suggestion but belongs in a different PR or ticket
- **Verification:** Check gate file `scope.in_scope` and `scope.out_of_scope`
- **Action:** Reply explaining why, resolve thread
- **Reply format:** "Good catch — out of scope for this PR ([PR title]). [1-line why]. Please reopen if you disagree or I've misunderstood."

### False positive
- **Criteria:** Reviewer misread the code, misunderstood the pattern, or the suggestion would introduce a regression
- **Action:** Reply with technical reasoning, resolve thread
- **Reply format:** "Keeping current implementation: [2-3 sentence reasoning]. [Code reference]. Please reopen if you disagree or I've misunderstood."

### Preference/style
- **Criteria:** Subjective style preference with no objective quality improvement
- **Action:** Reply acknowledging the perspective, resolve thread
- **Reply format:** "Acknowledged — keeping current approach because [rationale]. Please reopen if you disagree or I've misunderstood."

## Verification Checklist (before classifying as false positive)

Before concluding a reviewer is wrong, verify:

1. Re-read the reviewer's comment word-by-word — is the concern fully understood?
2. Check if the reviewer references a convention or pattern not yet known
3. Search `CLAUDE.md` and `turbo/CLAUDE.md` for related constraints
4. If the comment is about correctness, run the relevant lint/type-check
5. If the comment references a file, read that file
6. If uncertain after all checks, classify as "valid improvement" (err toward fixing)

## Thread Resolution Policy

All categories auto-resolve after replying. For non-fix categories (false positive, preference, out of scope), the reply MUST include:
- The specific code reference or evidence supporting the position
- The phrase "Please reopen if you disagree or I've misunderstood."

This ensures the reviewer can easily reopen if the agent's assessment is wrong.

## Agent Dispatch Pattern

### For Thread-Based Comments (unresolved review threads)

For each unresolved thread, the dispatched agent must:

1. Read the full thread (all comments, not just root)
2. Read the actual code at the referenced path and line
3. Read the PR diff for that file (`gh pr diff $PR_NUMBER -- <path>`)
4. If gate file exists, read scope and design decisions
5. Classify using this guide
6. Execute the action
7. Call `scripts/resolve-thread.sh <THREAD_ID>`

Fix agents must NOT post general PR comments — only thread replies on threads they address.

### For Body-Level Findings (Additional Findings not in diff)

Body findings are extracted from the review body's "Additional Findings (not in diff)" section. These reference code that is NOT in the PR diff but was flagged by the code-review pipeline. They have no GitHub review thread — they exist only as text in the review summary.

For each body finding, the dispatched agent must:

1. Read the actual code at the referenced file and approximate line (~line N is approximate)
2. Read surrounding context (20+ lines) to understand the code
3. The code is NOT in the PR diff — check if it is related to PR changes (called by changed code, shares state, etc.)
4. If gate file exists, read scope and design decisions
5. Classify using this guide (same 9 categories apply)
6. Execute the action:
   - **Fix categories (valid bug/convention/improvement):** Fix the code and commit. Even though the code is not in the diff, the code-review flagged it as an issue — it should be fixed.
   - **Non-fix categories:** Post a PR comment (`gh pr comment $PR_NUMBER --body "..."`) explaining the classification with evidence. Include the finding reference (file, line, description) so the reviewer can identify which body finding is being addressed.
7. There is NO thread to resolve — body findings are addressed by fixing the code and/or posting a PR comment.

**Reply format for body finding PR comments:**
```
Re: Additional Finding — `path/to/file` (~line N) — [Category]

[Action taken / reasoning]

Please reopen if you disagree or I've misunderstood.
```

**Scope note:** Body findings are explicitly about code NOT in the diff. The normal scope guard ("no files outside the PR diff") is relaxed for these — the code-review identified them as related issues. However, the agent should still verify the issue exists and is genuine before acting.

### For Human Review Body Comments

Human reviewers leave feedback in their review body text — especially with CHANGES_REQUESTED reviews. This feedback is high-level, not structured per-file like bot findings. It does NOT use the 9-category classification system.

**Key differences from bot findings:**
- **Human feedback is authoritative** — do not classify as "false positive" or "preference/style"
- **Human feedback overrides bot recommendations** — if a human says "don't do X" and a bot said "do X", follow the human
- **Human reviews are NEVER auto-resolved** — only the human reviewer can dismiss their CHANGES_REQUESTED
- **The 9-category classification does NOT apply** — human feedback is followed, not triaged

For each human review body comment, the dispatched agent must:

1. Read the entire review body carefully — understand the intent and constraints
2. Read the current PR diff to assess whether changes already satisfy the feedback
3. If the feedback is about **scope** (e.g. "never extend scope"):
   - Review all changes in the PR for scope violations
   - Revert or simplify any changes that violate the instruction
4. If the feedback is about **implementation** (e.g. "endpoint should be a stub"):
   - Make changes to match the reviewer's vision
   - Keep it minimal — do exactly what's asked
5. If the feedback is about **approach** (e.g. "use pattern from service Y"):
   - Read the referenced code for the pattern
   - Refactor to match
6. Post a PR comment confirming what was done, referencing the reviewer's feedback
7. **Do NOT call `resolve-thread.sh`** — human reviews have no thread to resolve

**Reply format for human review comments:**
```
Addressing @reviewer's feedback:

> [quoted feedback]

[What was done / what was changed]
```

**Priority:** Human review feedback takes the highest priority. Process it BEFORE bot body findings. If human feedback conflicts with bot findings, the human wins.

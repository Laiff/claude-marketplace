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

For each unresolved thread, the dispatched agent must:

1. Read the full thread (all comments, not just root)
2. Read the actual code at the referenced path and line
3. Read the PR diff for that file (`gh pr diff $PR_NUMBER -- <path>`)
4. If gate file exists, read scope and design decisions
5. Classify using this guide
6. Execute the action
7. Call `scripts/resolve-thread.sh <THREAD_ID>`

Fix agents must NOT post general PR comments — only thread replies on threads they address.

# Finding Schema

All agents in the review pipeline communicate using this structured YAML format.
Every finding passed between phases MUST include ALL fields.
Agents receiving findings from earlier phases MUST preserve existing fields
and only add or modify their designated fields.

## Finding Object

```yaml
id: "CONV-[hash:4]"              # <CATEGORY>-<4 chars of sha1(file:line)> `${file}:${line}`
file: "path/to/file.tsx"
line: 42
end_line: 45
category: CONV                   # BUG | SEC | PERF | CONV | ARCH | TEST
severity: NIT                    # CRIT | NORM | NIT
confidence: 85                   # 0-100 integer
claim_type: claude_md            # code_logic | claude_md | external_fact | deprecation | package_version
description: "Clear, actionable description of the issue"
evidence: "Quoted code, CLAUDE.md text, or tool output proving the issue"
suggestion: "How to fix — empty string if unclear, code block if < 6 lines"
suggestion_type: code            # code | description | none
claude_md_ref: 'Convention N: "exact rule text"'   # only for CONV findings
claude_md_path: "path/to/CLAUDE.md"                # only for CONV findings
source_agent: convention-checker  # set during merge step
validated: false                  # set by Phase 3
validation_reasoning: ""          # set by Phase 3
adjusted_confidence: null         # set by Phase 3
batch_key: null                   # set by Phase 4
batch_files: []                   # set by Phase 4
batched: false                    # set by Phase 4
also_affects: []                  # set by Phase 4
dedup_layer_applied: null         # set by Phase 4: exact | proximity | semantic
```

## Prior Verification Object

When `is_fix_verification` is true, Phase 2 review agents return a `prior_verification`
array alongside `findings`. Each entry reports whether a previously flagged issue was
addressed in the current commit. This data flows to the verdict and compose phases —
it is NOT part of the findings array.

```yaml
prior_verification:
  - dedup_key: "path/to/file.tsx:42:select-renders-blank"   # from comment-scanner dedup_keys
    description: "Select renders blank when role is 'member'"
    file: "path/to/file.tsx"
    line: 42
    category: BUG                    # original finding category
    status: fixed                    # fixed | not_fixed | partially_fixed
    reasoning: "Fallback SelectItem now added for roles absent from availableRoles"
```

## Field Ownership

| Phase | Fields SET | Fields READ |
|-------|-----------|-------------|
| Phase 2 (Review agents) | id, file, line, end_line, category, severity, confidence, claim_type, description, evidence, suggestion, suggestion_type, claude_md_ref, claude_md_path | PR context, CLAUDE.md content |
| Merge step | source_agent | — |
| Phase 3 (Evidence verifier) | validated, validation_reasoning, adjusted_confidence | All Phase 2 fields |
| Phase 4 (Dedup and budget) | batch_key, batch_files, batched, also_affects, dedup_layer_applied | All fields |

**Note:** `prior_verification` is a top-level array returned by Phase 2 agents alongside
`findings`, not a field on individual finding objects. It is only populated when
`is_fix_verification` is true.

## Review Verdict Object

Computed by Phase 4 alongside budget enforcement. Consumed by Phase 5 to determine
the GitHub review event type. See `protocols/review-verdict.md` for full decision matrix.

```yaml
verdict:
  action: REQUEST_CHANGES        # APPROVE | REQUEST_CHANGES | COMMENT
  classification: security        # security | bugs | conventions | architecture | mixed | clean
  reasoning: "1 CRIT security finding (SQL injection in auth route)"
  rule_applied: V1                # V1-V7 from decision matrix
  severity_distribution:
    CRIT: 1
    NORM: 2
    NIT: 0
  category_distribution:
    SEC: 1
    BUG: 1
    CONV: 1
    ARCH: 0
  calibration_applied: []         # VC1-VC5 guards that modified the default verdict
  prior_verification_summary:       # only present when is_fix_verification is true
    total: 2
    fixed: 2
    not_fixed: 0
    partially_fixed: 0
    items: []                        # the prior_verification array from Phase 2
```

### Verdict Field Ownership

| Field | Set by | Read by |
|-------|--------|---------|
| action | Phase 4 | Phase 5 (determines `gh pr review` flag) |
| classification | Phase 4 | Phase 5 (terminal summary header, PR comment) |
| reasoning | Phase 4 | Phase 5 (PR summary comment) |
| rule_applied | Phase 4 | Debugging, feedback-learner |
| severity_distribution | Phase 4 | Phase 5 (terminal summary) |
| category_distribution | Phase 4 | Phase 5 (terminal summary) |
| calibration_applied | Phase 4 | Debugging, feedback-learner |
| prior_verification_summary | Workflow JS (merge step) | Phase 5 (verification table in review body) |

## Rules

1. **Never drop fields** — downstream agents rely on all fields being present
2. **Never mutate upstream fields** — verifiers ADD, never overwrite
3. **id format** — `<CAT>-<4 chars of sha2(file:line)>` `${file}:${line}` ensures uniqueness across agents
4. **confidence scale** — 0-100 integer. External facts cap at 25 without tool proof
5. **suggestion_type** — `code` means the suggestion is a committable code block, `description` means prose instructions, `none` means no suggestion provided
6. **batch_key** — set by dedup phase when finding is consolidated into a batch. Format: `<category>-<normalized_description_hash_8>`
7. **YAML format** — all inter-agent data exchange uses YAML, never JSON
8. **verdict** — computed AFTER budget enforcement, reflects final surviving findings only

# Inter-Agent Communication Protocol v2

This protocol governs how agents in the review pipeline pass data between phases.
All inter-agent data exchange uses YAML format — never JSON.
Every production failure traced to "agent A didn't tell agent B about X" should be
prevented by a rule in this document.

---

## Principles

1. **YAML over prose** — All inter-agent data uses YAML blocks. Never pass findings as
   free-text paragraphs that the next agent must re-parse.
2. **Additive only** — Downstream agents ONLY ADD fields. They never overwrite upstream fields.
3. **Complete context** — Every agent receives the FULL output of all prerequisite phases,
   not a filtered subset. Filtering happens at the consuming agent's discretion.
4. **Fail-safe defaults** — If an agent fails or times out, the pipeline continues with
   an empty result from that agent, not a crash.
5. **Observable** — Every phase transition logs what was sent and received,
   enabling post-hoc debugging of finding loss.

---

## Phase Transition Contracts

### Phase 0 to Phase 1 (Preflight to Context)

```yaml
# Preflight output
proceed: true
reason: "PR is open, not a draft, not trivial, no prior review at this SHA"
```

If `proceed: false`, STOP. Log reason. Exit pipeline.
Otherwise launch Phase 1 agents in parallel with:

```yaml
owner: "owner-name"
repo: "repo-name"
pr_number: 1475
head_sha: "abc123def456..."
```

### Phase 1 to Phase 2 (Context to Review)

All three Phase 1 agents MUST complete before Phase 2 starts.
If any Phase 1 agent fails, use empty defaults:

```yaml
context:
  claude_mds: []                    # from context-collector (default: empty array)
  pr_summary:                       # from pr-summarizer (default: minimal)
    title: ""
    intent: "Unknown — summarizer failed"
    type: unknown
    scope: ""
    additions: 0
    deletions: 0
    files_changed: 0
    file_groups: {}
    key_changes: []
    risk_areas: []
    head_sha: ""
  existing_comments:                # from comment-scanner (default: no prior review)
    dedup_keys: []
    has_prior_review: false
    prior_review_sha: null
```

Each Phase 2 agent receives the ENTIRE context object. Agents must NOT re-fetch
data that is already in the context (especially the diff — see cost notes below).

### Phase 2 to Phase 3 (Review to Verification)

Phase 2 agents run in parallel. ALL must complete (or timeout at 120s) before Phase 3.

The evidence-verifier receives a MERGED array of all findings:

```yaml
findings:
  - id: "CONV-a1b2-42"
    file: "src/Component.tsx"
    line: 42
    category: CONV
    source_agent: convention-checker
    # ... all Finding fields
  - id: "BUG-c3d4-88"
    file: "src/utils.ts"
    line: 88
    category: BUG
    source_agent: bug-detector
    # ... all Finding fields
source_agents:
  - convention-checker
  - bug-detector
  - security-reviewer
context:
  # full Phase 1 context passed through
```

**Merge rules:**
- Concatenate all finding arrays from all Phase 2 agents
- Tag each finding with `source_agent` field (for cross-validation)
- Do NOT deduplicate at this stage — that is Phase 4's job

### Phase 3 to Phase 4 (Verification to Deduplication)

The dedup-orchestrator receives only VALIDATED findings:

```yaml
findings:
  # only findings where validated == true
  - id: "CONV-a1b2-42"
    validated: true
    adjusted_confidence: 92
    # ... all fields preserved
dropped_count: 5
dropped_reasons:
  low_confidence: 3
  contradicted_by_tool: 1
  claude_md_rule_not_found: 1
existing_comments:
  # from Phase 1C, passed through
pr_summary:
  # from Phase 1B, passed through
```

### Phase 4 to Phase 5 (Deduplication to Output)

```yaml
findings:
  # deduplicated, batched, budget-constrained
  - id: "CONV-a1b2-42"
    batch_key: null
    batch_files: []
    batched: false
    dedup_layer_applied: null
    also_affects: []
    # ... all upstream fields preserved
verdict:
  action: COMMENT                  # APPROVE | REQUEST_CHANGES | COMMENT
  classification: conventions      # security | bugs | conventions | architecture | mixed | clean
  reasoning: "2 NORM convention findings, no critical issues"
  rule_applied: V5
  severity_distribution:
    CRIT: 0
    NORM: 2
    NIT: 1
  category_distribution:
    SEC: 0
    BUG: 0
    CONV: 2
    ARCH: 1
  calibration_applied: []
stats:
  input_count: 15
  after_exact_dedup: 12
  after_proximity_dedup: 10
  after_semantic_dedup: 8
  after_existing_comment_filter: 7
  batch_groups_created: 1
  batch_findings_consolidated: 4
  budget_trimmed_count: 0
  final_count: 4
pr_summary:
  # from Phase 1B
head_sha: "abc123def456..."
owner_repo: "Owner/Repo"
pr_number: 1475
comment_flag: true
```

**Verdict rules:**
- Phase 4 computes the verdict AFTER budget enforcement using the final surviving findings
- See `protocols/review-verdict.md` for the full decision matrix (rules V1-V7)
  and calibration guards (VC1-VC5)
- Phase 5 uses `verdict.action` to determine the `gh pr review` flag

---

## Field Ownership Matrix

| Field | Set by | Modified by | Read by |
|-------|--------|-------------|---------|
| id | Phase 2 | — | Phase 3, 4, 5 |
| file, line, end_line | Phase 2 | — | All downstream |
| category, severity | Phase 2 | — | Phase 3 (verify), 4 (budget, verdict), 5 (format) |
| confidence | Phase 2 | — | Phase 3 (input to adjusted_confidence) |
| claim_type | Phase 2 | Phase 3 (correct if wrong) | Phase 3 |
| description, evidence | Phase 2 | — | Phase 3 (verify), 5 (post) |
| suggestion, suggestion_type | Phase 2 | — | Phase 5 (format) |
| claude_md_ref, claude_md_path | Phase 2 | — | Phase 3 (verify), 5 (link) |
| source_agent | Merge step | — | Phase 3 (cross-validate) |
| validated | Phase 3 | — | Phase 4 (filter) |
| validation_reasoning | Phase 3 | — | Phase 5 (optional display) |
| adjusted_confidence | Phase 3 | — | Phase 4 (sort and budget) |
| batch_key, batch_files | Phase 4 | — | Phase 5 (format) |
| batched | Phase 4 | — | Phase 5 (skip if true) |
| dedup_layer_applied | Phase 4 | — | Debugging |
| also_affects | Phase 4 | — | Phase 5 (display) |
| verdict.action | Phase 4 | — | Phase 5 (review event type) |
| verdict.classification | Phase 4 | — | Phase 5 (summary header, PR comment) |
| verdict.reasoning | Phase 4 | — | Phase 5 (PR summary comment) |
| verdict.rule_applied | Phase 4 | — | Debugging, feedback-learner |
| verdict.severity_distribution | Phase 4 | — | Phase 5 (terminal summary) |
| verdict.category_distribution | Phase 4 | — | Phase 5 (terminal summary) |
| verdict.calibration_applied | Phase 4 | — | Debugging, feedback-learner |

---

## Error Handling

### Agent Timeout
- Phase 0 (preflight): 30s timeout — default to `proceed: true` (review is safer than skip)
- Phase 1 agents: 60s timeout — use empty defaults (defined above)
- Phase 2 agents: 120s timeout — continue with findings from agents that completed
- Phase 3 (verifier): 120s timeout — pass all findings through unvalidated (set `validated: true`, `validation_reasoning: "Verifier timed out — unvalidated"`)
- Phase 4 (dedup): 60s timeout — pass all findings through without dedup
- Phase 5 (output): 120s timeout — print raw findings to terminal

### Agent Crash
- Log the error with agent name, phase, and input size
- Use the same defaults as timeout
- Add a note in the terminal summary: "Note: {agent} failed — results may be incomplete"

### Empty Finding Set
- If Phase 2 produces 0 findings: this is a VALID outcome (clean PR)
- Skip Phase 3 and Phase 4 entirely
- Phase 5 outputs "No issues found" summary
- This is a GOOD result — do not treat it as an error

---

## Cost Optimization Rules

The biggest cost driver in production was redundant diff fetching (approximately 15x in one $10.30 trace).

1. **Diff is pre-fetched** at `.claude-review-context/diff.txt` — NEVER run `gh pr diff`
2. **PR metadata is pre-fetched** at `.claude-review-context/pr_meta.yaml` (YAML format) — NEVER run `gh pr view` for metadata
3. **Prior reviews are pre-fetched** at `.claude-review-context/prior_reviews.yaml` — contains threads, reactions, signal classification. Comment-scanner MUST read this first, NEVER call `gh api .../comments` directly
4. **Diff patch positions are pre-fetched** at `.claude-review-context/file_patches.json` — output-composer MUST read this instead of calling `gh api .../pulls/{number}/files`
5. **Structured context envelope** at `.claude-review-context/context.yaml` — repo, PR number, head SHA, file counts, index of all pre-fetched files
6. **Phase 1 output is the single source of truth** — Phase 2 agents MUST use the context object, not re-fetch from GitHub API
7. **Convention text is in context** — do not re-read CLAUDE.md files in Phase 2 or later
8. **Head SHA is in context.yaml and pr_summary** — do not run `git rev-parse HEAD`

Estimated cost per review with this protocol: $0.30-$0.80 (vs $10.30 without optimization).

---

## Observability

Each phase transition should log to terminal (not GitHub):

```
[Phase N->N+1] Passed {count} findings | Dropped {count} | Duration {ms}ms
```

The final output-composer logs a pipeline summary:

```
Pipeline summary:
  Phase 2: 15 findings (conv: 8, bug: 4, sec: 3)
  Phase 3: 10 validated, 5 dropped (low_conf: 3, contradicted: 1, rule_missing: 1)
  Phase 4: 4 final (dedup: -3, batch: -2, budget: -1)
  Verdict: REQUEST_CHANGES (security) — rule V1, calibration: none
  Phase 5: 1 review posted (3 inline + 1 in body), event: REQUEST_CHANGES
  Total duration: 45s
```

Phase 5 posts exactly ONE review — no separate summary comment.

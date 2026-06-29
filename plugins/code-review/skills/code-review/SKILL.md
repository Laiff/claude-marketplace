---
description: "Code review a pull request. Triggers on: review PR, check PR, code review, audit pull request, review this PR, review changes. Evidence-driven multi-agent review with feedback-grounded quality guards, three-layer deduplication, and YAML-structured inter-agent communication."
allowed-tools: |
    Bash(gh issue view:*), Bash(gh search:*), Bash(gh issue list:*), Bash(gh pr comment:*), Bash(gh pr diff:*), Bash(gh pr view:*), Bash(gh pr list:*),
    Bash(gh pr review:*), Bash(gh api:*), Bash(gh auth:*), Bash(python3:*), Bash(curl:*), Bash(wc:*), Bash(sort:*), Bash(rm:*),
    Read, Write, Edit, Grep, Glob, Agent
---

# Code Review Skill

You are an evidence-driven code review orchestrator. Your task is to review a pull request
using a multi-agent pipeline that maximizes signal-to-noise ratio.

## Core Principles

1. **Silence is better than noise** — GitHub Copilot averages 5.1 comments per review across 60M+ reviews. 29% of reviews are silent. This is by design.
2. **Every comment costs human attention** — 21+ comments triggers "approve and move on" behavior. Budget accordingly.
3. **Hunk-level over file-level** — 19.2% addressing rate at hunk-level vs 4.2% at file-level (arXiv 2508.18771). Always anchor findings to specific changed lines.
4. **Acceptance signal is the learning mechanism** — thumbs_down, confused reactions, and minimized-as-spam reviews are debts. Track and learn from them.
5. **External facts are unreliable from training data** — 76.4% of developers report high hallucination rates. External claims require tool verification.

## Pipeline Overview

```
PR Event
│
▼
Phase 0 ── Preflight (haiku, 30s)
│
├─ no ──▶ STOP, log reason
│
▼ yes
Phase 1 ── Context Gathering (3× haiku, parallel)
│   ├─ context-collector
│   ├─ pr-summarizer
│   └─ comment-scanner
│
⊕── wait all, full context (YAML)
│
Phase 2 ── Review (3× sonnet, parallel)
│   ├─ convention-checker
│   ├─ bug-detector
│   └─ security-reviewer
│
⊕── merge findings, tag source_agent
│
Phase 3 ── evidence-verifier (sonnet)
│   ├─ classify claim type
│   ├─ verify external facts via tool
│   ├─ cross-validate between agents
│   └─ drop adjusted_confidence < 80
│
▿── validated findings only
│
Phase 4 ── dedup-orchestrator (haiku)
│   ├─ L1 exact match
│   ├─ L2 location proximity
│   ├─ L3 semantic near-dedup
│   ├─ batch guard (>3 files → 1 comment)
│   ├─ budget cap (≤10 comments)
│   └─ verdict + classification
│
▿── final findings + verdict + stats
│
Phase 5 ── output-composer (sonnet)
│   ├─ terminal summary with verdict (always)
│   ├─ single atomic review: APPROVE | REQUEST_CHANGES | COMMENT
│   ├─ inline comments in review (--post flag)
│   └─ non-inlineable findings in review body
```

## Execution

**Primary execution path**: invoke the Workflow tool with `scriptPath` pointing to the
workflow script bundled in this plugin. Do NOT regenerate or inline the script — use
the pre-built file directly.

```
Workflow({
  scriptPath: "<plugin_dir>/workflows/code-review/code-review.js",
  args: {
    owner:       "ORG_OR_USER",        // GitHub org or user (required)
    repo:        "REPO_NAME",          // GitHub repo name (required)
    pr_number:   123,                  // PR number to review (required)
    post_flag:   true,                 // Post review to GitHub? (optional, default: false)
    context_dir: "/path/to/context",   // Pre-fetched context directory (optional)
    head_sha:    "abc123def456...",     // HEAD commit SHA (optional, resolved from PR if omitted)
    plugin_dir:  "<plugin_dir>"        // Path to this plugin's root (optional but recommended)
  }
})
```

### Args Reference

| Arg | Type | Required | Default | Description |
|-----|------|----------|---------|-------------|
| `owner` | string | **yes** | — | GitHub repository owner (org or user). Example: `"Reluna-Family"` |
| `repo` | string | **yes** | — | GitHub repository name. Example: `"FG"` |
| `pr_number` | number | **yes** | — | Pull request number to review. Example: `1873` |
| `post_flag` | boolean | no | `false` | Whether to post the review to GitHub. When `false`, only a terminal summary is printed. When `true`, a single atomic review is posted via `gh api`. |
| `context_dir` | string | no | `null` | Path to a directory containing pre-fetched PR context files (`diff.txt`, `pr_meta.yaml`, `prior_reviews.yaml`, `relevant_claude_mds.txt`, `context.yaml`, `file_patches.json`). When provided, agents read from these files instead of calling `gh` CLI — faster and avoids rate limits. Typically set by CI runners. |
| `head_sha` | string | no | `null` | The HEAD commit SHA of the PR. Used for posting inline review comments at the correct commit. If omitted, resolved from the PR summary agent's output. |
| `plugin_dir` | string | no | `null` | Absolute path to this plugin's installed root directory. Used to resolve agent instruction files (`agents/*.md`) and protocol files (`protocols/*.md`). When omitted, agents fall back to inline prompts without reading external instruction files — still functional but less precise. |

### How to resolve args values

**`owner` and `repo`**: Extract from the PR URL, or from `git remote get-url origin`, or ask the user.

**`pr_number`**: From the user's request (`"review PR #123"`), or from `gh pr list`, or from `gh pr view --json number`.

**`post_flag`**: Default `false` for dry-run reviews. Set to `true` when the user says `--post`, `post it`, `submit the review`, or equivalent.

**`context_dir`**: Only relevant in CI environments where a pre-fetch step populates context files. In interactive use, leave as `null` — agents will call `gh` commands directly.

**`head_sha`**: Run `gh pr view <number> --repo <owner>/<repo> --json headRefOid -q .headRefOid` to resolve, or let the pipeline resolve it automatically.

**`plugin_dir`**: The path where this plugin is installed. In Claude Code this is typically the plugin cache path shown in the skill resolution context. If not available, omit it — the pipeline still works but agents won't read their extended instruction files.

### What the script does (phase summary)

All orchestration, schemas, prompts, and control flow live inside the workflow script.
The skill does NOT need to re-describe agent prompts. The script handles everything:

| Phase | Agents | Model | Purpose |
|-------|--------|-------|---------|
| 0 Preflight | preflight | haiku | Gate check — should this PR be reviewed? |
| 1 Context | context-collector, pr-summarizer, comment-scanner | haiku (×3 parallel) | Gather conventions, summarize PR, scan existing comments |
| 2 Review | convention-checker, bug-detector, security-reviewer | sonnet (×3 parallel) | Convention, bug, and security review |
| 3 Verify | evidence-verifier | sonnet | Evidence grounding and cross-validation |
| 4 Dedup | dedup-orchestrator | haiku | Three-layer dedup, batch guard, budget cap, verdict |
| 5 Compose | output-composer | sonnet | Terminal summary + post atomic GitHub review |

Short-circuit: if Phase 2 produces 0 findings → Phases 3–4 are skipped → clean APPROVE.

### Protocols (read by agents via `plugin_dir`)

All agents follow the protocols defined in `protocols/agent-communication.md`,
apply filters from `protocols/quality-guards.md`, and communicate using the
schema defined in `protocols/finding-schema.md`.

### Review Verdict and Classification

The pipeline determines a review verdict and classification in Phase 4, used by Phase 5
to post the correct GitHub review event. See `protocols/review-verdict.md` for full details.

**Verdict actions:**

| Action | When | Effect |
|--------|------|--------|
| APPROVE | 0 findings after all filtering | Approves the PR on GitHub |
| REQUEST_CHANGES | CRIT findings, or 3+ NORM bugs, or public-facing SEC | Blocks merge until addressed |
| COMMENT | Advisory findings (NORM conventions, NITs, 1-2 bugs) | Posts feedback without blocking |

**Classification types:**

| Type | Icon | Trigger |
|------|------|---------|
| security | :shield: | Majority SEC findings or any CRIT SEC |
| bugs | :bug: | Majority BUG findings or any CRIT BUG |
| conventions | :memo: | Majority CONV findings |
| architecture | :building_construction: | Majority ARCH findings |
| mixed | :mag: | No single category majority |
| clean | :white_check_mark: | 0 findings |

**Calibration guards** prevent over/under-aggressive verdicts:
- VC1: Never REQUEST_CHANGES for NITs alone
- VC2: Never APPROVE with unresolved findings
- VC3: Respect project-level `review_policy` in CLAUDE.md / REVIEW.md
- VC4: Downgrade internal services (except CRIT)
- VC5: Never REQUEST_CHANGES on draft PRs
- VC6: Fix-verification consistency — don't REQUEST_CHANGES for implementing prior review's recommendation

### Trust Calibration

From research on developer trust (code-review-automation research tree, depth 4):

- **Confidence display**: Always show confidence score in terminal summary
- **Claim type transparency**: Prefix external fact claims with `[unverified]` if tool check failed
- **Severity calibration cues**: Show deployment topology reasoning for security findings
- **Actionability**: Every finding must have either a code suggestion or clear fix description
- **Batch transparency**: When batching, state how many individual instances were consolidated

### Feedback Loop Hooks

After each review, the output-composer captures these signals for future improvement:
- Total findings generated vs. findings that survived validation
- Batch consolidation count (how many individual comments became batches)
- Comment budget trimming count (how many findings dropped for budget)
- Finding category distribution (BUG, CONV, SEC, ARCH)
- Which guards triggered and how often

## Quality Guards Summary

| Guard | What it prevents | Source |
|-------|-----------------|--------|
| G1: Noise filter | "test" body, <20 char comments | Production: confused reactions |
| G2: Scope guard | Flagging unchanged code | Production: off-topic minimization |
| G3: Dedup guard | Re-posting same finding | Production: 23% multi-run duplication |
| G4: Batch guard | Same comment on N files | Production: number one spam minimization cause |
| G5: Evidence grounding | False external claims | Production: version hallucinations |
| G6: Exception clauses | Repo-specific false positives | Production: inline style FPs |
| G7: Security calibration | Over-escalating internal services | Production: internal CRIT FPs |
| G8: Comment budget | Developer fatigue (21+ triggers bulk dismiss) | Research: Copilot 60M benchmark |
| G9: False positive filter | General low-signal noise | Production: minimization analysis |
| G10: Verdict calibration | Over-aggressive REQUEST_CHANGES | Production: trust erosion, topology mismatch |
| G11: Prior review consistency | Contradicting own prior review recommendations | Production: fix-verification self-contradiction |

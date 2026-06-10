# laiff-claude-marketplace

Personal Claude Code plugin marketplace — research-driven plugins for code review, agent orchestration, and developer workflows.

## Installation

```bash
/plugin marketplace add Laiff/claude-marketplace
```

Then install individual plugins:

```bash
/plugin install code-review@laiff-claude-marketplace
```

## Plugins

### code-review v4.7.0

Evidence-driven code review with multi-agent orchestration, feedback-grounded quality guards, and YAML-structured inter-agent communication.

**Skill:** `/code-review` — triggers on: review PR, check PR, code review, audit pull request

**Pipeline:**

```
Phase 0  Preflight gate (haiku)
Phase 1  Context gathering: 3 agents in parallel (haiku)
Phase 2  Review: 3 agents in parallel (sonnet)
Phase 3  Evidence verification (sonnet)
Phase 4  Three-layer dedup + verdict (haiku)
Phase 5  Output composition + GitHub posting (sonnet)
```

**11 Agents:**

| Agent | Model | Role |
|-------|-------|------|
| preflight | haiku | Gate check — should this PR be reviewed at all |
| context-collector | haiku | Gather CLAUDE.md, conventions, project context |
| pr-summarizer | haiku | Structured PR summary with intent, scope, risk |
| comment-scanner | haiku | Scan existing comments to prevent re-posting |
| convention-checker | sonnet | CLAUDE.md compliance audit |
| bug-detector | sonnet | Logic bugs, type errors, null derefs, resource leaks |
| security-reviewer | sonnet | Security vulnerabilities and architecture |
| evidence-verifier | sonnet | Validate claims, cross-check between agents |
| dedup-orchestrator | haiku | Three-layer dedup, batch guard, budget cap |
| output-composer | sonnet | Final review output, inline comments, PR posting |
| feedback-learner | sonnet | Learn from reactions, minimize future noise |

**4 Protocols:**

| Protocol | Purpose |
|----------|---------|
| agent-communication | YAML-structured inter-agent data exchange |
| finding-schema | Finding object definition with confidence scoring |
| quality-guards | 10 guards preventing noise (G1-G10) |
| review-verdict | APPROVE / REQUEST_CHANGES / COMMENT decision logic |

**Quality Guards:**

| Guard | Prevents |
|-------|----------|
| G1 Noise filter | Trivial or empty comments |
| G2 Scope guard | Flagging unchanged code |
| G3 Dedup guard | Re-posting same finding |
| G4 Batch guard | Same comment on N files |
| G5 Evidence grounding | False external claims |
| G6 Exception clauses | Repo-specific false positives |
| G7 Security calibration | Over-escalating internal services |
| G8 Comment budget | Developer fatigue (max 10 comments) |
| G9 False positive filter | General low-signal noise |
| G10 Verdict calibration | Over-aggressive REQUEST_CHANGES |

## Repository Structure

```
.claude-plugin/
  marketplace.json          Marketplace catalog
plugins/
  code-review/
    .claude-plugin/
      plugin.json           Plugin manifest
    agents/                 11 specialized agents
    protocols/              4 inter-agent protocols
    skills/
      code-review/
        SKILL.md            Main skill entry point
```

## Author

[Laiff](https://github.com/Laiff)

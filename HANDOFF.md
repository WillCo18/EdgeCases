# Edge Case Auditor Skill — Handoff Document

**Date:** 2026-03-16
**Project:** Skill for Antigravity automation community competition
**Status:** Iteration 3 complete, ready for review or further iteration

---

## What This Skill Does

The **edge-case-auditor** skill audits code for failure modes, edge cases, and fragile assumptions before they become production bugs. It's designed for automation builders using AI coding tools (Cursor, Windsurf, Claude Code, etc.) who need a pre-deploy safety net.

It covers three domains:
- **Next.js / frontend apps** (Supabase, Stripe, Vercel)
- **MCP servers and API integrations** (Claude API, webhooks, external services)
- **Automation pipelines** (scheduled jobs, data sync, event-driven workflows)

---

## File Locations

### The Skill (what you'd submit/package)
```
edge-case-auditor/
  SKILL.md                      <- Main skill instructions (iteration 3, current best)
  references/
    automation.md               <- Automation pipeline edge case checklist
    mcp-api.md                  <- MCP server + API integration checklist
    nextjs.md                   <- Next.js / frontend checklist
  evals/
    evals.json                  <- Test case definitions with assertions
```

### Original Files (your starting point)
```
files/
  SKILL.md                      <- Original version you provided
  automation.md                 <- Original reference
  mcp-api.md                   <- Original reference
  nextjs.md                    <- Original reference
  edge-case-auditor.skill      <- Original packaged .skill file
```

### Workspace (all eval data)
```
edge-case-auditor-workspace/
  research-ai-pitfalls.md      <- Summary of web research findings

  iteration-1/                  <- First eval run (original skill + minor improvements)
    benchmark.json
    feedback.json               <- Your review feedback from the eval viewer
    stripe-airtable-sync/       <- Eval 0
    nextjs-saas-app/            <- Eval 1
    python-data-pipeline/       <- Eval 2

  iteration-2/                  <- Second eval run (breadth fix + format improvements)
    benchmark.json
    stripe-airtable-sync/
    nextjs-saas-app/
    python-data-pipeline/

  iteration-3/                  <- Third eval run (tighter reports + what's solid + specific follow-ups)
    benchmark.json              <- Full comparison with all prior iterations
    stripe-airtable-sync/
    nextjs-saas-app/
    python-data-pipeline/
```

---

## What We Did (Chronological)

### 1. Setup
- Extracted original files into a proper skill directory structure
- Created 3 realistic test projects:
  - **Stripe-Airtable sync** — Express webhook server syncing payments (JS)
  - **Next.js SaaS app** — Supabase + Stripe billing + cron job + dashboard (TS)
  - **Python data pipeline** — CSV ingestion to Postgres on a 15-min schedule

### 2. Research
Ran two parallel research agents scanning Reddit, forums, and the web for real-world edge case problems. Key findings:
- **Moltbook breach** — vibe-coded app leaked 1.5M API keys due to missing Supabase RLS
- **Enrichlead** — Cursor-built SaaS bypassed in 72 hours (client-side only auth)
- **AI code has 1.57x more security issues** than human-written code (happy path bias)
- Full research saved in `edge-case-auditor-workspace/research-ai-pitfalls.md`

### 3. Iteration 1: Baseline Eval
- **Results:** Skill scored 100% on assertions, baseline scored 87%
- **Problem:** Skill found FEWER total issues than baseline (9 vs 12 avg) — capping at 5-8
- **Your feedback:** "Discovery breadth deficit is the primary SKILL.md fix needed"

### 4. Iteration 2: Breadth Fix
- Removed the "top 5-8 issues" cap
- Added AI-generated code awareness
- Added Risk Summary table + Deployment Checklist
- **Results:** Pass rate 100% vs 83% baseline. Issue counts doubled (19.3 avg)
- **Problem identified in review:** Reports felt padded — too many "Worth noting" items that were filler

### 5. Iteration 3: Tightening + Tone (Current)
Changes made to SKILL.md:
- **Added severity calibration guidelines** — explicit definitions for Critical/High/Worth noting with examples
- **Added "What's solid" section** — 2-4 bullets acknowledging what the build gets right before listing problems
- **Made "When it triggers" conditional** — only include when the trigger is non-obvious
- **Made follow-up offer specific** — reference the actual highest-impact fix, not generic "want me to fix any of these?"
- **Strengthened "Don't pad" guidance** — "10 real issues > 22 with half filler"
- **Tightened "Worth noting" tier** — cut feature requests, duplicates, hypotheticals

---

## Iteration 3 Results

### Assertion Pass Rates

| Eval | With Skill | Without Skill |
|------|-----------|---------------|
| Stripe-Airtable Sync | 10/10 (100%) | 10/10 (100%) |
| Next.js SaaS App | 10/10 (100%) | 8/10 (80%) |
| Python Data Pipeline | 10/10 (100%) | 9/10 (90%) |
| **Average** | **100%** | **90%** |

### Key Metrics Comparison (All 3 Iterations)

| Metric | Iter 1 Skill | Iter 2 Skill | Iter 3 Skill | Iter 3 Baseline |
|--------|-------------|-------------|-------------|-----------------|
| Pass Rate | 100% | 100% | 100% | 90% |
| Avg Issues | 9.7 | 19.3 | 12.7 | 16.0 |
| Avg Tokens | ~22,000 | 22,695 | 14,861 | 12,688 |
| Time Delta vs Baseline | — | +53.4s | +13.6s | — |
| Token Delta vs Baseline | — | +63% | +17% | — |

### What Improved in Iteration 3

1. **Reports are tighter.** Issue counts dropped from 19.3 → 12.7. The "Worth noting" tier now has 3-4 items (was 5-7). No filler.
2. **"What's solid" section works.** All 3 reports open with genuine positives — e.g., the Next.js report correctly praises the existing webhook signature verification.
3. **Specific follow-up offers.** Each report ends with a concrete fix proposal — e.g., "Want me to refactor `process_csv` with connection management, error handling, batch inserts, and idempotent upserts in one pass?"
4. **Token cost dropped 35%.** From 22,695 → 14,861 avg. Tighter reports = cheaper runs.
5. **Time overhead dropped 75%.** From +53.4s → +13.6s over baseline.

### Consistent Skill Wins (Baseline Never Catches These)

- **Insert vs upsert on webhook retries** — baseline missed this in all 3 iterations on Next.js
- **Specific follow-up offer** with concrete fix reference — baseline never produces this
- **Consistent report format** — Risk Summary table, Deployment Checklist, Verdict always present
- **"What's solid" section** — builds trust, baseline never acknowledges positives

### What the Baseline Improved On

- Stripe baseline hit 10/10 for the first time (was 9/10 in iterations 1-2)
- Python baseline caught DB connection leak (missed in iteration 2)
- Overall baseline pass rate rose from 83% → 90%

---

## Current Benchmark Summary

| Metric | With Skill | Without Skill | Delta |
|--------|-----------|---------------|-------|
| Pass Rate | 100% | 90% | +10% |
| Avg Issues Found | 12.7 | 16.0 | -3.3 (intentional — tighter) |
| Avg Time | 80.3s | 66.7s | +13.6s |
| Avg Tokens | 14,861 | 12,688 | +17% |

The skill's advantage has shifted from "more issues" (iter 2) to "better issues + better format + consistent unique catches" (iter 3). The reports are more concise, more credible, and more actionable.

---

## What's Left To Do

### If you want another iteration:
1. Review the iteration-3 outputs in `iteration-3/*/with_skill/outputs/audit-report.md`
2. Compare against the baselines in `without_skill/outputs/`
3. Provide feedback on what to improve
4. Run iteration 4

### If you're happy with it:
1. **Description optimization** — run the automated trigger-testing loop to make sure the skill activates reliably on the right prompts
2. **Package the skill** — create a `.skill` file for submission
3. **Expand test cases** — add more evals (e.g., a Docker/Kubernetes deployment, a Make.com/n8n workflow, a Supabase-heavy app) for broader coverage

### Competition considerations:
- The skill's strongest differentiator is **insert-vs-upsert detection on webhook retries** — Claude consistently misses this without the skill
- The **"What's solid" section** is unusual and builds trust — most audit tools are purely negative
- The **specific follow-up offers** demonstrate deeper understanding than a generic checklist
- The **token efficiency improvement** (35% reduction from iter 2) shows the skill doesn't waste compute
- The **research-backed reference files** give the checklists credibility with real incidents

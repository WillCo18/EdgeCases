# Edge Case Auditor

A Claude Code skill that catches production failure modes, edge cases, and fragile assumptions before they become runtime errors.

Built for the [Antigravity](https://www.antigravity.so/) automation community skill competition.

## What it does

If you've ever shipped something that worked perfectly in dev and then fell over the moment real users touched it — missing error handling, webhook retries creating duplicate records, an auth flow that returns null for every user — this skill is for that.

It reads your actual code, checks it against a checklist of real-world failure modes, and gives you a prioritised report of what's going to bite you. Not style nits. Not theoretical concerns. Actual things that will break.

## What it covers

Three domains, because those are what the community mostly builds:

- **Next.js / frontend apps** — Supabase auth in server components, insert vs upsert on webhook retries, session token leaks, missing RLS, cron endpoints left wide open
- **MCP servers and API integrations** — stdout pollution crashing JSON-RPC, missing signature verification, no timeout on outbound calls, orphaned processes
- **Automation pipelines** — no overlap protection on scheduled jobs, connection leaks, idempotency gaps, files loaded entirely into memory

Each domain has a reference checklist built from real incidents (the Moltbook breach, the Enrichlead bypass, common n8n production failures) so the audit is grounded in things that actually happened, not hypothetical scenarios.

## How it works

Say something like "audit this before I deploy" or "what could go wrong" and the skill:

1. Reads your code (not just the conversation — it actually opens the files)
2. Classifies your build type and picks the right checklist
3. Starts by telling you what's solid (so you know what NOT to touch)
4. Lists issues in severity tiers with specific file references and fix code
5. Gives you a deployment checklist and a concrete next step

The output looks like a senior dev reviewing your PR — not a linter, not a generic security scanner.

## What makes it different

The thing the skill consistently catches that Claude doesn't on its own: **insert vs upsert on webhook retries**. Stripe retries webhooks routinely. If your handler uses `.insert()`, every retry creates a duplicate record. Claude without the skill misses this in most cases. With the skill, it catches it every time.

It also does things baseline Claude never does:
- Opens with what's working (builds trust, tells you what not to break)
- Offers a specific follow-up fix, not a generic "want me to help?"
- Gets severity right (a missing `vercel.json` that silently prevents your cron from ever running is not a "nice to have")

## Eval results

4 iterations of evals across 3 test projects (Stripe webhook server, Next.js SaaS app, Python data pipeline):

| Metric | With Skill | Without Skill | Delta |
|--------|-----------|---------------|-------|
| Assertion Pass Rate | 100% | 90% | +10% |
| Avg Issues Found | 12.7 | 16.0 | -3.3 (tighter, less noise) |
| Avg Tokens | 14,861 | 12,688 | +17% |

## Repo structure

```
edge-case-auditor/          # The skill
  SKILL.md                  # Main skill instructions
  references/               # Domain-specific checklists
  evals/                    # Test case definitions

edge-case-auditor-workspace/  # Eval data (4 iterations)
  iteration-1/ .. iteration-4/
  research-ai-pitfalls.md   # Web research on AI code failure modes

files/                      # Original source files
covering-letter.md          # Competition submission letter
HANDOFF.md                  # Detailed development history
```

## Who it's for

Anyone building automations, SaaS apps, or integrations with AI tools who wants to ship with confidence instead of crossing their fingers.

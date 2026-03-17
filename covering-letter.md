# Edge Case Auditor

## What it does

Catches the stuff that breaks in production before you get there.

If you've ever shipped something that worked perfectly in dev and then fell over the moment real users touched it — missing error handling, webhook retries creating duplicate records, an auth flow that returns null for every single user — this skill is for that.

It reads your actual code, checks it against a checklist of real-world failure modes, and gives you a prioritised report of what's going to bite you. Not style nits. Not theoretical concerns. Actual things that will break.

## Why I built it

Most of us building with AI coding tools (Cursor, Windsurf, Claude Code) have hit the same wall: the code works for the demo, then falls apart under real conditions. AI-generated code has a well-documented happy path bias — it writes the thing that works when everything goes right, and skips the error paths, the retry logic, the null checks, the concurrency guards.

I wanted something that catches those gaps before they become 2am debugging sessions.

## What it covers

Three domains, because those are what the community mostly builds:

- **Next.js / frontend apps** — Supabase auth in server components, insert vs upsert on webhook retries, session token leaks, missing RLS, cron endpoints left wide open
- **MCP servers and API integrations** — stdout pollution crashing JSON-RPC, missing signature verification, no timeout on outbound calls, orphaned processes
- **Automation pipelines** — no overlap protection on scheduled jobs, connection leaks, idempotency gaps, files loaded entirely into memory

Each domain has a reference checklist built from real incidents (the Moltbook breach, the Enrichlead bypass, common n8n production failures) so the audit is grounded in things that actually happened to people, not hypothetical scenarios.

## How it works in practice

You say something like "audit this before I deploy" or "what could go wrong" and the skill:

1. Reads your code (not just the conversation — it actually opens the files)
2. Classifies your build type and picks the right checklist
3. Starts by telling you what's solid (so you know what NOT to touch)
4. Lists issues in severity tiers with specific file references and fix code
5. Gives you a deployment checklist and a concrete next step

The output looks like a senior dev reviewing your PR — not a linter, not a generic security scanner. It names your actual variables and functions, shows you exactly what will break and when, and gives you copy-pasteable fixes.

## What makes it different

The thing the skill consistently catches that Claude doesn't on its own: **insert vs upsert on webhook retries**. Stripe retries webhooks routinely. If your handler uses `.insert()`, every retry creates a duplicate record. Claude without the skill misses this in most cases. With the skill, it catches it every time and tells you to use `.upsert()` with the right conflict key.

It also does things baseline Claude never does:
- Opens with what's working (builds trust, tells you what not to break)
- Offers a specific follow-up fix, not a generic "want me to help?"
- Gets severity right (a missing `vercel.json` that silently prevents your cron from ever running is not a "nice to have")

## The numbers

We ran 4 iterations of evals across 3 test projects (Stripe webhook server, Next.js SaaS app, Python data pipeline), comparing with-skill vs without-skill:

- **Skill pass rate: 100%** across all 4 iterations (30/30 assertions every time)
- **Baseline pass rate: 87% → 93%** (improves over time but never hits 100%)
- **Reports are tighter** — 12.7 issues avg vs baseline's 14.0 (less noise, every issue earns its place)

## Who it's for

Anyone building automations, SaaS apps, or integrations with AI tools who wants to ship with confidence instead of crossing their fingers. It's the difference between "I think it works" and "I know where the gaps are."

The goal isn't perfection — it's catching the things that would have taken you hours to debug at 2am on a Saturday.

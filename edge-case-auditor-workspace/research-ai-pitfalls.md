---
source: Web research agent - AI coding tool pitfalls
date: 2026-03-16
---

# Key Findings for Skill Improvement

## NEW categories to add to reference files:

### 1. AI-Generated Code Specific (NEW REFERENCE FILE?)
- Happy path bias — AI generates code that works for demo but lacks error paths
- No resilience mechanisms (retries, timeouts, circuit breakers) unless explicitly requested
- Verbose error handling that leaks stack traces
- Weak session/token management, outdated auth patterns
- 1.57x more security issues than human-written code
- XSS vulnerabilities 2.74x more likely
- Code duplication up to 8x — makes bugs harder to isolate

### 2. MCP Server Gaps (add to mcp-api.md)
- stdout pollution crashes JSON-RPC protocol — any debug logging to stdout breaks it
- Environment variable loss in GUI apps (macOS/Windows don't inherit shell env)
- Orphaned processes — callback servers not shutting down
- No standardized vetting — anyone can publish MCP servers

### 3. n8n/Automation Platform Gaps (add to automation.md)
- Production webhook URL differs from test URL — silently fails
- Production webhook returns 200 OK even when no webhook registered
- WEBHOOK_URL env var misconfiguration behind reverse proxies

### 4. Scale/Production Gaps
- N+1 queries only surface under load
- Missing connection pooling
- Race conditions in async/await code
- 15-20 component threshold where AI context breaks down

## Real incidents to reference:
- EnrichLead: Zero hand-written code SaaS, attackers bypassed paywall in 2 days
- Tea App: 72,000 images exposed due to Firebase auth config
- SaaStr: AI agent deleted 1,206 records during code freeze
- n8n CVE-2026-21858: CVSS 10.0 unauthenticated RCE

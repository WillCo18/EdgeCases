# MCP Server & API Integration Edge Case Reference

Use this file when auditing MCP servers, REST API integrations, or any build that connects to external services.

---

## MCP Server

- [ ] Tool handler not wrapped in try/catch — unhandled error crashes the server process (and ends the entire conversation)
- [ ] Tool returns raw error object instead of structured error message with `isError` flag — client can't recover gracefully
- [ ] No input schema validation — malformed tool arguments cause undefined behaviour
- [ ] Long-running tool has no timeout — hangs indefinitely if external call stalls
- [ ] Tool name collision with built-in Claude tools — unpredictable which gets called
- [ ] Server not restarting on crash — single failure takes it down permanently until manually restarted
- [ ] Secrets (API keys) hardcoded in tool definitions — exposed in tool metadata visible to Claude
- [ ] No logging — impossible to debug failures after the fact
- [ ] SSE connection not handling client disconnect — server keeps processing after client gone
- [ ] Tool descriptions too vague — Claude picks the wrong tool or doesn't use it
- [ ] Debug output written to stdout — pollutes JSON-RPC protocol stream and crashes communication (MCP uses stdout for JSON-RPC; all logging must go to stderr)
- [ ] Environment variables not available — GUI-launched apps (macOS/Windows) don't inherit shell environment; PATH, API keys silently missing
- [ ] Orphaned callback processes — local HTTP servers or child processes not shut down when the MCP host app closes
- [ ] No tool-level permission scoping — tools granted full filesystem or network access when they only need a narrow subset

---

## External API Integration

- [ ] No retry logic — transient network errors cause permanent failures
- [ ] No timeout set on fetch/axios — hangs indefinitely if upstream stalls
- [ ] Rate limit errors (429) not caught — crashes instead of backing off and retrying
- [ ] API key rotated / expired — no fallback, silent or cryptic error
- [ ] Response shape assumed — `.data.items[0].name` throws if shape varies or is empty
- [ ] Pagination not handled — only first page returned, rest silently dropped
- [ ] Webhook signature not verified — accepts spoofed payloads (Stripe: `constructEvent()`, GitHub: HMAC check, etc.)
- [ ] Error responses from API not parsed — `response.ok` false but body contains useful error message that's discarded
- [ ] No circuit breaker — repeated failures to external service cause cascading timeouts across the system

---

## Authentication (API / OAuth)

- [ ] Access token not refreshed — works until token expires, then silently fails
- [ ] Refresh token stored insecurely (localStorage, unencrypted DB field)
- [ ] OAuth state parameter not validated — CSRF vulnerability in OAuth flow
- [ ] Bearer token included in GET request URLs — logged in server access logs
- [ ] API key sent in query string rather than header — logged by proxies/CDNs
- [ ] Auth check only in UI layer — API endpoints accessible without valid token if called directly

---

## Anthropic / Claude API Specific

- [ ] No `max_tokens` set — response cut off unpredictably
- [ ] System prompt and user message both set incorrectly — conflated, model confused
- [ ] Streaming not handled — response only arrives after full completion, poor UX
- [ ] Tool use response not checked for `stop_reason: "tool_use"` — tool call missed
- [ ] Conversation history growing unbounded — context window exceeded, 400 error
- [ ] Model string hardcoded and outdated — breaks when model is deprecated

---

## Pinecone / Vector DB

- [ ] Namespace doesn't exist — upsert silently creates it but query to non-existent namespace returns empty, not an error
- [ ] Embedding dimension mismatch — upsert fails with unhelpful error
- [ ] Index not created before first upsert — throws on first run
- [ ] `topK` set too low — returns fewer results than expected, appears like missing data
- [ ] Metadata not indexed — filter queries return empty even when records exist
- [ ] No deduplication — re-running pipeline creates duplicate vectors

---

## Payment Integration (Stripe / LemonSqueezy)

- [ ] Webhook handler missing signature verification — forged events accepted
- [ ] No idempotency on webhook processing — Stripe retries create duplicate records/charges
- [ ] `event.id` not stored/checked — same event processed multiple times
- [ ] Checkout session metadata assumed present — `session.metadata.userId` throws if metadata wasn't set
- [ ] Subscription period dates hardcoded instead of read from Stripe object — wrong for annual/trial/custom plans
- [ ] Missing event types — only handling `checkout.session.completed` but not `customer.subscription.updated` or `invoice.payment_failed`

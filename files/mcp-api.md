# MCP Server & API Integration Edge Case Reference

Use this file when auditing MCP servers, REST API integrations, or any build that connects to external services.

---

## MCP Server

- [ ] Tool handler not wrapped in try/catch — unhandled error crashes the server process
- [ ] Tool returns raw error object instead of structured error message — client can't parse it
- [ ] No input schema validation — malformed tool arguments cause undefined behaviour
- [ ] Long-running tool has no timeout — hangs indefinitely if external call stalls
- [ ] Tool name collision with built-in Claude tools — unpredictable which gets called
- [ ] Server not restarting on crash — single failure takes it down permanently until manually restarted
- [ ] Secrets (API keys) hardcoded in tool definitions — exposed in tool metadata visible to Claude
- [ ] No logging — impossible to debug failures after the fact
- [ ] SSE connection not handling client disconnect — server keeps processing after client gone
- [ ] Tool descriptions too vague — Claude picks the wrong tool or doesn't use it

---

## External API Integration

- [ ] No retry logic — transient network errors cause permanent failures
- [ ] No timeout set on fetch/axios — hangs indefinitely if upstream stalls
- [ ] Rate limit errors (429) not caught — crashes instead of backing off and retrying
- [ ] API key rotated / expired — no fallback, silent or cryptic error
- [ ] Response shape assumed — `.data.items[0].name` throws if shape varies or is empty
- [ ] Pagination not handled — only first page returned, rest silently dropped
- [ ] Webhook signature not verified — accepts spoofed payloads
- [ ] Error responses from API not parsed — `response.ok` false but body contains useful error message that's discarded

---

## Authentication (API / OAuth)

- [ ] Access token not refreshed — works until token expires, then silently fails
- [ ] Refresh token stored insecurely (localStorage, unencrypted DB field)
- [ ] OAuth state parameter not validated — CSRF vulnerability in OAuth flow
- [ ] Bearer token included in GET request URLs — logged in server access logs
- [ ] API key sent in query string rather than header — logged by proxies/CDNs

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

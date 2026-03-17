# Audit Report: Stripe-Airtable Sync Webhook Server

**Project:** stripe-airtable-sync
**Date:** 2026-03-16
**Scope:** Pre-deployment review before hosting on DigitalOcean droplet
**Files reviewed:** `server.js`, `package.json`, `.env`

---

## Critical Issues

### 1. No Stripe Webhook Signature Verification

**Severity: CRITICAL**
**File:** `server.js`, line 13

The server blindly trusts `req.body` without verifying the Stripe webhook signature. Anyone who discovers the `/webhook/stripe` endpoint can POST fabricated events, inserting fake payment records into Airtable or triggering arbitrary Stripe API calls.

**Fix:** Use `stripe.webhooks.constructEvent(rawBody, sig, endpointSecret)` to verify the `stripe-signature` header. This requires reading the raw body (`express.raw({ type: 'application/json' })`) instead of `express.json()`, since signature verification needs the unparsed body.

### 2. Unauthenticated Manual Sync Endpoint

**Severity: CRITICAL**
**File:** `server.js`, lines 54-74

`GET /sync/payments` is completely open. Anyone who hits this URL triggers bulk Stripe API reads and bulk Airtable writes. This is an abuse vector (data exfiltration of payment counts, Airtable quota exhaustion, Stripe rate-limit burning) and a potential data integrity issue (duplicate records on every call).

**Fix:** At minimum, protect this endpoint with a shared secret (API key in a header or query param). Better: remove it from the production deployment entirely and run manual syncs via a CLI script or admin-only route.

### 3. `.env` Contains Live Secret Key

**Severity: CRITICAL**
**File:** `.env`

The `.env` file contains what appears to be a live Stripe secret key (`sk_live_abc123`). There is no `.gitignore` file in the project, so this file will be committed to version control if the project is ever tracked with git. Even without git, deploying by copying the project directory risks exposing secrets.

**Fix:** Add a `.gitignore` that excludes `.env`. On the droplet, set environment variables directly (e.g., via systemd unit `Environment=` directives, or a deployment tool) rather than shipping a `.env` file.

---

## High-Severity Issues

### 4. Zero Error Handling

**Severity: HIGH**
**File:** `server.js`, lines 12-52 and 54-74

Every `await` call (Airtable create, Stripe customer retrieve, Stripe paymentIntents list) can throw. There are no try/catch blocks and no Express error-handling middleware. In production:

- A single Airtable API timeout will crash the Node process (unhandled promise rejection).
- The webhook handler will never send the `200` response, causing Stripe to retry the event, potentially leading to duplicate records when the retry succeeds.
- The `/sync/payments` endpoint will hang on error.

**Fix:** Wrap async logic in try/catch. Always return `res.json({ received: true })` from the webhook handler (even on failure) to prevent Stripe retries for transient downstream errors. Add a global Express error handler.

### 5. No Idempotency / Duplicate Protection

**Severity: HIGH**
**File:** `server.js`, lines 18-29 and 57-70

- **Webhooks:** Stripe may deliver the same event more than once (network retries, at-least-once delivery). Each delivery creates a new Airtable row, producing duplicates.
- **Manual sync:** Every call to `/sync/payments` re-creates all recent payments in Airtable without checking whether they already exist.

**Fix:** Track the Stripe event ID (or payment intent ID) and check for existing records in Airtable before inserting. Use `filterByFormula` on the Airtable query, or maintain a local set/cache of processed event IDs.

### 6. No Process Manager or Restart Strategy

**Severity: HIGH**
**File:** `package.json` (start script)

`node server.js` will simply exit on an uncaught exception or OOM. On a bare droplet there is nothing to restart it.

**Fix:** Use PM2, systemd, or Docker with a restart policy. At minimum: `pm2 start server.js --name stripe-sync`.

---

## Medium-Severity Issues

### 7. No HTTPS / TLS Termination Plan

**Severity: MEDIUM**

The server listens on port 3000 over plain HTTP. Stripe requires HTTPS for webhook endpoints. On a raw droplet you need a reverse proxy (nginx/Caddy) with TLS, or Cloudflare in front.

### 8. Hardcoded Port

**Severity: MEDIUM**
**File:** `server.js`, line 76

Port 3000 is hardcoded. This makes it harder to run behind a reverse proxy on a non-standard port or to configure via environment.

**Fix:** `const PORT = process.env.PORT || 3000;`

### 9. No Logging Beyond `console.log`

**Severity: MEDIUM**
**File:** `server.js`, line 31

Only one `console.log` exists, and only for the `checkout.session.completed` path. There is no logging for subscription events, errors, or the sync endpoint. In production you will have no visibility into what is happening.

**Fix:** Use a structured logger (pino, winston) and log all incoming events, outcomes, and errors.

### 10. Null/Undefined Property Access

**Severity: MEDIUM**
**File:** `server.js`, lines 21, 42

- `session.customer_details.email` -- `customer_details` or `email` can be null if the checkout session was created without collecting customer details.
- `subscription.items.data[0].price.nickname` -- `nickname` is null if the price does not have one set in the Stripe dashboard.

These will throw `TypeError: Cannot read properties of null` and crash the handler (see issue #4).

**Fix:** Use optional chaining and provide fallback values: `session.customer_details?.email ?? 'unknown'`.

### 11. Manual Sync Only Fetches First 100 Payments

**Severity: MEDIUM**
**File:** `server.js`, line 55

`stripe.paymentIntents.list({ limit: 100 })` only retrieves the first page. If there are more than 100 payment intents, the rest are silently ignored.

**Fix:** Use Stripe's auto-pagination: `for await (const payment of stripe.paymentIntents.list({ limit: 100 }))`.

### 12. Sequential Airtable Writes in Sync Endpoint

**Severity: MEDIUM**
**File:** `server.js`, lines 57-71

Each payment is written to Airtable one at a time with `await` inside a `for` loop. For 100 payments, this means 100 sequential HTTP requests, which will take a long time and is more likely to hit Airtable's rate limit (5 requests/second on free tier).

**Fix:** Batch records (Airtable's create API accepts up to 10 records at a time). Chunk the array and send in parallel batches with rate-limit awareness.

---

## Low-Severity / Operational Issues

### 13. No Health Check Endpoint

A simple `GET /health` returning 200 is essential for monitoring (uptime checks, load balancer health probes).

### 14. No `.gitignore`

No `.gitignore` exists. `node_modules/`, `.env`, and OS files (`.DS_Store`) will be tracked if git is initialized.

### 15. No `nodemon` in devDependencies

`package.json` references `nodemon` in the dev script but does not list it as a dependency.

### 16. No `engines` Field in `package.json`

No Node.js version is pinned. The `"type": "module"` field requires Node >= 12, and the Stripe SDK v14 likely requires Node >= 14 or 16. Specifying `"engines": { "node": ">=18" }` prevents surprises on the droplet.

---

## Summary of Recommendations (Priority Order)

| Priority | Action |
|----------|--------|
| **P0** | Add Stripe webhook signature verification |
| **P0** | Protect or remove the `/sync/payments` endpoint |
| **P0** | Add `.gitignore`; never commit `.env` |
| **P1** | Add try/catch and Express error-handling middleware |
| **P1** | Add idempotency checks (deduplicate by event/payment ID) |
| **P1** | Use a process manager (PM2 or systemd) |
| **P2** | Set up HTTPS via reverse proxy (nginx + Let's Encrypt, or Caddy) |
| **P2** | Make port configurable via `PORT` env var |
| **P2** | Add structured logging |
| **P2** | Add null-safety for optional Stripe fields |
| **P3** | Add a `/health` endpoint |
| **P3** | Batch Airtable writes and paginate Stripe reads |
| **P3** | Add `.gitignore`, pin Node version in `engines` |

---

*This audit focused on what could go wrong when moving from a local dev environment to a public-facing production server. The three critical issues (no signature verification, open sync endpoint, exposed secrets) should be resolved before deployment.*

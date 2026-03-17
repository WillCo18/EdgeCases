# Audit Report: Stripe-to-Airtable Webhook Sync Server

**Project:** `stripe-airtable-sync`
**Files reviewed:** `server.js`, `package.json`, `.env`
**Date:** 2026-03-16

---

## Executive Summary

This is a small Express server that receives Stripe webhook events and writes payment/subscription data into Airtable. It also exposes a manual sync endpoint. While functional for local development, deploying this as-is to a DigitalOcean droplet carries **critical security vulnerabilities**, **data-integrity risks**, and **reliability gaps** that could lead to financial data loss, duplicate records, or unauthorized access.

---

## Critical Issues

### 1. No Stripe Webhook Signature Verification

**Severity: CRITICAL**
**File:** `server.js`, line 13

The webhook endpoint blindly trusts `req.body` without verifying the `Stripe-Signature` header. Anyone who discovers the `/webhook/stripe` URL can POST fabricated events, injecting fake payment records into Airtable.

**What could go wrong:** An attacker sends forged `checkout.session.completed` events, polluting your payments table with fake data, or triggering downstream business logic based on fabricated payments.

**Fix:** Use `stripe.webhooks.constructEvent(rawBody, sig, endpointSecret)` with `express.raw()` instead of `express.json()` for the webhook route. Store the webhook signing secret (`whsec_...`) in your environment variables.

---

### 2. `.env` File Contains Live Secret Keys

**Severity: CRITICAL**
**File:** `.env`, line 1

The `.env` file contains what appears to be a live Stripe secret key (`sk_live_abc123`). There is no `.gitignore` file in the project, meaning this file will be committed to version control if you use git.

**What could go wrong:** Leaked Stripe secret keys give full access to your Stripe account -- refunds, transfers, customer data, everything.

**Fix:**
- Add a `.gitignore` that excludes `.env`.
- Rotate the Stripe key immediately if it has ever been committed.
- On the droplet, use environment variables set at the OS/systemd level rather than a `.env` file sitting in the project directory.

---

### 3. Unprotected Manual Sync Endpoint

**Severity: HIGH**
**File:** `server.js`, lines 54-74

The `GET /sync/payments` endpoint has zero authentication. Anyone who hits that URL triggers a bulk sync that creates records in Airtable and hammers both the Stripe and Airtable APIs.

**What could go wrong:**
- Accidental or malicious repeated calls create massive duplicate records in Airtable.
- Airtable rate limits (5 requests/sec) are quickly exceeded, causing partial syncs and silent data loss.
- Stripe API rate limits are hit, potentially affecting your production payment flow.

**Fix:** Add authentication (API key header, basic auth, or IP allowlist). At minimum, remove this endpoint in production or gate it behind admin auth.

---

## Major Issues

### 4. No Error Handling Anywhere

**Severity: HIGH**
**File:** `server.js`, lines 12-52, 54-74

There are no `try/catch` blocks around any `await` calls. If the Airtable API is down, rate-limited, or returns an error, the unhandled promise rejection will crash the Express server (Node.js default behavior for unhandled rejections in newer versions).

**What could go wrong:**
- A single Airtable timeout crashes the entire server.
- Stripe returns a `200` response expectation, but your server returns a 500 error, causing Stripe to retry the webhook -- and if the Airtable write partially succeeded, you get duplicates on the retry.
- The `/sync/payments` endpoint fails mid-loop with no indication of which records were synced.

**Fix:** Wrap all async operations in try/catch. For the webhook endpoint specifically, return `res.json({ received: true })` early (within a few seconds) and process the event asynchronously, or at minimum catch errors and still return 200 to Stripe to prevent retries.

---

### 5. No Idempotency / Duplicate Protection

**Severity: HIGH**
**File:** `server.js`, lines 18-29, 38-48, 57-70

Stripe delivers webhooks with at-least-once semantics. If your server is slow to respond, Stripe will retry the event. Each retry creates a new Airtable record because there is no deduplication check.

The `/sync/payments` endpoint is even worse -- every call creates new records for the same payments, with no check for existing records.

**What could go wrong:** Your Airtable payments table fills with duplicate rows. Financial reporting based on this data will be wrong.

**Fix:**
- Store and check `event.id` (for webhooks) before processing to skip already-handled events.
- For the sync endpoint, query Airtable for existing `Payment ID` before creating, or use Airtable's `typecast` with a unique field.

---

### 6. Null/Undefined Property Access

**Severity: HIGH**
**File:** `server.js`, lines 21, 42

- `session.customer_details.email` -- `customer_details` can be `null` if the session doesn't collect customer info, causing a crash: `Cannot read property 'email' of null`.
- `subscription.items.data[0].price.nickname` -- `nickname` is optional on Stripe prices and is often `null`. `data[0]` will throw if `items.data` is empty.

**What could go wrong:** A single checkout session without customer details crashes the server, taking down all webhook processing.

**Fix:** Use optional chaining (`session.customer_details?.email ?? 'unknown'`) and validate required fields before writing to Airtable.

---

## Moderate Issues

### 7. No Process Manager or Restart Strategy

**Severity: MEDIUM**

`package.json` only has `node server.js` as the start script. On a bare droplet, if the process crashes (see issues 4 and 6), it stays down until someone manually restarts it.

**What could go wrong:** Server crashes at 2 AM, Stripe webhook deliveries fail for hours, and events are eventually dropped after Stripe exhausts its retry window (typically 72 hours, but events queue up and ordering issues compound).

**Fix:** Use PM2 (`pm2 start server.js --name stripe-sync`) or a systemd service unit with `Restart=always`.

---

### 8. No HTTPS / TLS Termination

**Severity: MEDIUM**

The server listens on plain HTTP port 3000. Stripe requires HTTPS for webhook endpoints in live mode. Beyond that, all API keys transit in plaintext if accessed directly.

**Fix:** Put Nginx or Caddy in front as a reverse proxy with TLS (Let's Encrypt). Stripe will refuse to deliver webhooks to an `http://` URL in production.

---

### 9. Hardcoded Port

**Severity: LOW**
**File:** `server.js`, line 76

Port 3000 is hardcoded. On a shared droplet or behind a reverse proxy, you may need flexibility.

**Fix:** Use `process.env.PORT || 3000`.

---

### 10. No Logging Beyond console.log

**Severity: LOW**
**File:** `server.js`, lines 31, 76

Only one success case is logged (line 31). Failures, subscription events, and sync operations produce no logs. When something goes wrong in production, you will have no diagnostic information.

**Fix:** Use a structured logger (e.g., `pino` or `winston`) with timestamps. Log all incoming event types, all errors, and all Airtable write results.

---

### 11. Airtable Rate Limiting on Bulk Sync

**Severity: MEDIUM**
**File:** `server.js`, lines 57-70

The `/sync/payments` loop fires sequential `await` calls with no rate limiting. Airtable's API allows 5 requests per second per base. With 100 payments, you will hit the rate limit within seconds, and Airtable will return 429 errors, which are not caught (see issue 4).

Additionally, `stripe.paymentIntents.list({ limit: 100 })` only fetches the first 100 payments. If you have more, the rest are silently ignored.

**Fix:** Batch Airtable creates (up to 10 records per call), add delays between batches, and use Stripe pagination (`auto_paging_each`) if you need all records.

---

### 12. No Health Check Endpoint

**Severity: LOW**

There is no `GET /health` or similar endpoint. Monitoring tools, load balancers, and uptime checkers have nothing to ping.

**Fix:** Add a simple `app.get('/health', (req, res) => res.json({ status: 'ok' }))`.

---

## Deployment Checklist

Before deploying to the DigitalOcean droplet:

- [ ] **Add Stripe webhook signature verification** (critical)
- [ ] **Add `.gitignore` excluding `.env`** and rotate any committed keys
- [ ] **Add try/catch error handling** to all async routes
- [ ] **Add idempotency checks** to prevent duplicate Airtable records
- [ ] **Add null-safety** for `customer_details`, `price.nickname`, etc.
- [ ] **Protect or remove** the `/sync/payments` endpoint
- [ ] **Set up Nginx/Caddy** with TLS for HTTPS
- [ ] **Use PM2 or systemd** to keep the process alive
- [ ] **Add structured logging** for debugging production issues
- [ ] **Add a health check endpoint**
- [ ] **Batch Airtable writes** and respect rate limits

---

## Risk Summary

| # | Issue | Severity | Category |
|---|-------|----------|----------|
| 1 | No webhook signature verification | CRITICAL | Security |
| 2 | Live secrets in `.env`, no `.gitignore` | CRITICAL | Security |
| 3 | Unprotected sync endpoint | HIGH | Security |
| 4 | No error handling | HIGH | Reliability |
| 5 | No idempotency / duplicate protection | HIGH | Data Integrity |
| 6 | Null/undefined property access crashes | HIGH | Reliability |
| 7 | No process manager | MEDIUM | Operations |
| 8 | No HTTPS | MEDIUM | Security |
| 9 | Hardcoded port | LOW | Configuration |
| 10 | Minimal logging | LOW | Observability |
| 11 | Airtable rate limits on bulk sync | MEDIUM | Reliability |
| 12 | No health check endpoint | LOW | Operations |

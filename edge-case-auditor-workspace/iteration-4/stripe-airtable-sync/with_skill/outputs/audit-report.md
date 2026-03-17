# Edge Case Audit: Stripe-to-Airtable Webhook Sync

**Scope:** `server.js`, `package.json`, `.env` -- Express webhook server syncing Stripe payment/subscription events to Airtable, targeting DigitalOcean deployment.

---

### What's solid

- **Clean event routing.** The webhook handler dispatches on `event.type` with focused handlers per event -- straightforward and readable.
- **Correct unit conversion.** Stripe amounts (cents) are divided by 100 before writing to Airtable, and `start_date` is correctly converted from Unix seconds to ISO string.
- **Reasonable Airtable field mapping.** Field names are human-readable and the `create()` call structure matches the Airtable SDK correctly.

---

### Critical -- Will break in production

**1. Webhook signature not verified -- anyone can forge payment events**
- **Where:** `server.js:11`
- **What happens:** The endpoint accepts any POST body as a legitimate Stripe event. An attacker can POST a fake `checkout.session.completed` event with arbitrary data, creating bogus payment records in Airtable -- or worse, triggering downstream business logic that treats those records as real revenue.
- **Fix:** Use `stripe.webhooks.constructEvent()` with the raw body. This requires switching from `express.json()` to a raw body parser on this route:
```js
import { buffer } from 'micro'; // or use express.raw

app.post('/webhook/stripe',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body, sig, process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error('Signature verification failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }
    // ... rest of handler
  }
);
```
Add `STRIPE_WEBHOOK_SECRET=whsec_...` to your environment.

**2. No error handling -- one failed Airtable write crashes the response and Stripe retries forever**
- **Where:** `server.js:14-38` (entire webhook handler)
- **What happens:** If the Airtable API call throws (rate limit, network timeout, schema mismatch), the unhandled promise rejection crashes the request. Express returns a 500, Stripe sees a failure, and retries the event -- hitting the same error, up to dozens of times over 72 hours. No `try/catch` anywhere.
- **Fix:** Wrap each event handler in try/catch. Return `200` to Stripe to acknowledge receipt, then handle the write failure separately (log, queue for retry, alert):
```js
try {
  await base('Payments').create([{ fields: { ... } }]);
} catch (err) {
  console.error('Airtable write failed:', err);
  // Don't rethrow -- still return 200 to stop Stripe retries
}
res.json({ received: true });
```

**3. `.env` contains live secret key -- will be committed to version control**
- **Where:** `.env`
- **What happens:** The file contains `sk_live_abc123` (a live Stripe secret key pattern). If this repo is pushed to GitHub without a `.gitignore` excluding `.env`, the key is exposed publicly. GitHub bots scrape for these patterns within minutes.
- **Fix:** (a) Add `.gitignore` with `.env` entry. (b) Rotate the Stripe key immediately if this has already been committed. (c) On DigitalOcean, set env vars via the droplet's environment or a secrets manager, not a file in the repo.

**4. `/sync/payments` endpoint is unauthenticated and creates duplicate records**
- **Where:** `server.js:42-57`
- **What happens:** Anyone who discovers this GET endpoint can trigger a bulk sync. Every call creates new Airtable records for the same payments -- there is no deduplication check. Hitting it twice doubles your Airtable data. It also only fetches the first 100 payments (Stripe default page), silently ignoring the rest.
- **Fix:** (a) Add authentication (API key header, IP allowlist, or remove the endpoint entirely if it's a one-off migration tool). (b) Before creating, query Airtable for existing `Payment ID` to skip duplicates. (c) Use `stripe.paymentIntents.list` with auto-pagination if you need all records.

---

### High -- Will bite you under realistic conditions

**5. No idempotency on webhook processing -- duplicate Airtable records on Stripe retries**
- **Where:** `server.js:14-38`
- **What happens:** Stripe retries webhooks on timeout or non-2xx response. Since the handler never checks whether an event has already been processed (no `event.id` tracking), each retry creates a new Airtable row. A single payment can produce 5+ duplicate records during network instability.
- **Fix:** Store processed `event.id` values (in Airtable itself, Redis, or a simple file/DB). Check before processing:
```js
const existing = await base('WebhookLog').select({
  filterByFormula: `{Event ID} = '${event.id}'`,
  maxRecords: 1
}).firstPage();
if (existing.length > 0) {
  return res.json({ received: true, duplicate: true });
}
```

**6. Null reference on `session.customer_details.email`**
- **Where:** `server.js:18`
- **What happens:** `customer_details` can be `null` on checkout sessions where the customer wasn't required to provide an email (e.g., certain payment link configurations, or when using `customer` instead of `customer_details`). Accessing `.email` on `null` throws a TypeError, crashing the handler.
- **Fix:** Add a guard: `const email = session.customer_details?.email ?? 'unknown';`

**7. `subscription.items.data[0].price.nickname` may be null**
- **Where:** `server.js:31`
- **What happens:** `price.nickname` is only populated if you explicitly set it in the Stripe dashboard or API. By default it's `null`, so your Airtable "Plan" field gets `null` instead of a meaningful value. If your Airtable field validation rejects nulls, the entire write fails.
- **Fix:** Fall back: `subscription.items.data[0].price.nickname ?? subscription.items.data[0].price.id`

**8. No process manager -- server dies on unhandled error and stays dead**
- **Where:** Deployment architecture
- **What happens:** On a bare DigitalOcean droplet, `node server.js` runs as a foreground process. Any unhandled exception (and there are several possible, see above) kills the process permanently. No automatic restart, no log persistence.
- **Fix:** Use PM2 or systemd:
```bash
npm install -g pm2
pm2 start server.js --name stripe-sync
pm2 save
pm2 startup  # generates systemd service for boot persistence
```

**9. No health check endpoint**
- **Where:** `server.js` (missing)
- **What happens:** DigitalOcean load balancers, uptime monitors, and deployment scripts need a health check path. Without one, you have no automated way to detect if the server is up. You'll discover outages from angry customers, not monitoring.
- **Fix:** Add a simple route:
```js
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));
```

**10. Missing critical Stripe event types**
- **Where:** `server.js:13, 26`
- **What happens:** Only `checkout.session.completed` and `customer.subscription.created` are handled. Real subscription lifecycles produce `customer.subscription.updated` (plan changes, cancellations), `customer.subscription.deleted`, and `invoice.payment_failed` (failed renewal charges). Your Airtable will show subscriptions as perpetually active even after cancellation.
- **Fix:** Add handlers for at minimum: `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`. Update the corresponding Airtable records using `select` + `update` rather than `create`.

---

### Worth noting -- Low risk but worth a look

**11. No HTTPS termination configured**
- **Where:** Deployment architecture
- **What happens:** Express listens on port 3000 over plain HTTP. Stripe requires HTTPS for webhook endpoints. You'll need a reverse proxy (Nginx/Caddy) or DigitalOcean's load balancer with TLS termination in front of this server.
- **Fix:** Use Caddy (auto-TLS) as a reverse proxy, or configure Nginx with Let's Encrypt.

**12. No request timeout on outbound Stripe API call**
- **Where:** `server.js:28` (`stripe.customers.retrieve`)
- **What happens:** The `customers.retrieve` call inside the webhook handler has no timeout. If the Stripe API is slow, your webhook response to Stripe itself times out, triggering a retry loop.
- **Fix:** Configure a global timeout on the Stripe client: `new Stripe(key, { timeout: 10000 })`.

---

### Risk Summary

| # | Issue | Severity | Effort to Fix |
|---|-------|----------|---------------|
| 1 | Webhook signature not verified | Critical | 15 min |
| 2 | No error handling in webhook | Critical | 10 min |
| 3 | `.env` with live keys, no `.gitignore` | Critical | 5 min |
| 4 | `/sync/payments` unauthenticated + creates dupes | Critical | 20 min |
| 5 | No idempotency -- duplicate records on retry | High | 30 min |
| 6 | Null ref on `customer_details.email` | High | 2 min |
| 7 | `price.nickname` often null | High | 2 min |
| 8 | No process manager | High | 10 min |
| 9 | No health check endpoint | High | 2 min |
| 10 | Missing subscription lifecycle events | High | 30 min |
| 11 | No HTTPS termination | Worth noting | 15 min |
| 12 | No Stripe API timeout | Worth noting | 2 min |

---

### Deployment Checklist (Critical + High only)

- [ ] Add webhook signature verification with `stripe.webhooks.constructEvent()` and `STRIPE_WEBHOOK_SECRET`
- [ ] Wrap all Airtable writes in try/catch; always return 200 to Stripe
- [ ] Add `.gitignore` excluding `.env`; rotate Stripe key if already committed; use env vars on droplet
- [ ] Authenticate or remove `/sync/payments`; add deduplication logic
- [ ] Track processed `event.id` to prevent duplicate Airtable records on retries
- [ ] Guard against null `customer_details` and null `price.nickname`
- [ ] Install PM2 and configure for auto-restart on crash and on reboot
- [ ] Add `GET /health` endpoint
- [ ] Add handlers for `subscription.updated`, `subscription.deleted`, `invoice.payment_failed`

---

**Verdict:** This server will process webhook events on the happy path, but it is not safe to deploy as-is. The missing signature verification is an exploitable security hole, and the lack of error handling combined with no idempotency means the first Airtable hiccup will cascade into duplicate records across dozens of Stripe retries.

**Suggested next action:** Start with issue #1 (webhook signature verification) -- it's the highest-impact fix at 15 minutes of work, and it blocks the most dangerous attack vector. Then add try/catch error handling (#2) before anything else, since every other fix is moot if unhandled exceptions keep crashing the process.

---

Want me to write the hardened version of the webhook handler with signature verification, error handling, and idempotency checks all wired together?

# Edge Case Audit — Automation Pipeline (Webhook + Data Sync) — Pre-Deploy

**What I reviewed:** `server.js`, `package.json`, `.env` — the full project (3 files total). Express webhook server receiving Stripe events and syncing payment/subscription records to Airtable, plus a manual sync endpoint.

**Build health:** Critical Issues — multiple issues that will cause failures or security exposure under normal production conditions.

---

## Critical — Will break in production

**1. Stripe webhook signature not verified — anyone can POST fake payment events**
- **Where:** `server.js:12-13` — `/webhook/stripe` handler
- **What happens:** The handler reads `req.body` directly and trusts it. There is no call to `stripe.webhooks.constructEvent()` to verify the `Stripe-Signature` header. Any actor who discovers the endpoint URL can POST fabricated payment events, injecting fake records into your Airtable.
- **When it triggers:** As soon as the endpoint is publicly reachable on your DigitalOcean droplet.
- **Fix:** Add a webhook signing secret and verify every request:
  ```js
  // Use express.raw() instead of express.json() for the webhook route
  app.post('/webhook/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      console.error('Webhook signature verification failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }
    // ... process event
  });
  ```
  Add `STRIPE_WEBHOOK_SECRET` to your `.env`.

**2. Zero error handling — any Airtable or Stripe API failure crashes the server**
- **Where:** `server.js:18-29` — `base('Payments').create(...)`, `server.js:36` — `stripe.customers.retrieve(...)`, `server.js:38-48` — `base('Subscriptions').create(...)`
- **What happens:** Every `await` call is unwrapped — no try/catch anywhere in the webhook handler or the sync endpoint. If Airtable is rate-limited (5 req/sec on their API), returns an error, or if the Stripe customer lookup fails, the unhandled rejection will crash the Express process. Since there is no process manager configured (no pm2, no systemd restart), the server stays down.
- **When it triggers:** First time Airtable returns a 422 (e.g., a field name mismatch), a 429 rate limit, or any network interruption.
- **Fix:** Wrap each handler in try/catch and return appropriate status codes:
  ```js
  try {
    await base('Payments').create([...]);
  } catch (err) {
    console.error('Airtable write failed:', err);
    return res.status(500).json({ error: 'Failed to sync payment' });
  }
  ```

**3. Null property access on `session.customer_details.email` will throw**
- **Where:** `server.js:22` — `session.customer_details.email`, `server.js:31`
- **What happens:** For guest checkouts or certain Stripe configurations, `customer_details` can be `null`. Accessing `.email` on `null` throws a `TypeError` which — combined with issue #2 — crashes the server.
- **When it triggers:** When a checkout session completes without customer details populated (e.g., certain payment links, B2B invoice payments).
- **Fix:** Use optional chaining: `session.customer_details?.email ?? 'unknown'`

---

## High — Will bite you under realistic conditions

**4. No idempotency — duplicate Airtable records on webhook retries**
- **Where:** `server.js:18-29` — `base('Payments').create(...)`, `server.js:38-48` — `base('Subscriptions').create(...)`
- **What happens:** Stripe retries webhooks when it doesn't get a 2xx response quickly enough (or at all). Every retry creates a new Airtable record because `create()` is used without any deduplication check against `Payment ID` or `Subscription ID`. You will end up with duplicate rows in Airtable.
- **When it triggers:** Any transient slowness in your handler (Airtable latency, network hiccup) causes Stripe to retry within its timeout window.
- **Fix:** Before creating, query Airtable for an existing record with the same `Payment ID` / `Subscription ID`:
  ```js
  const existing = await base('Payments').select({
    filterByFormula: `{Payment ID} = '${payment.id}'`,
    maxRecords: 1
  }).firstPage();
  if (existing.length === 0) {
    await base('Payments').create([...]);
  }
  ```

**5. `/sync/payments` endpoint is unauthenticated and creates duplicates**
- **Where:** `server.js:54-74` — `GET /sync/payments`
- **What happens:** This endpoint is publicly accessible with no auth. Anyone who hits it triggers a full Stripe payment sync. It also has no deduplication — every call creates new Airtable records for the same payments. Additionally, it only fetches the first 100 payments (`limit: 100`) with no pagination, so it silently drops older payments.
- **When it triggers:** Any time the endpoint is called more than once, or when you have more than 100 payments in Stripe.
- **Fix:** Add authentication (even a simple bearer token check), add deduplication logic, and implement pagination using Stripe's `starting_after` cursor for full sync.

**6. `subscription.items.data[0].price.nickname` will throw on plans without a nickname**
- **Where:** `server.js:42` — `subscription.items.data[0].price.nickname`
- **What happens:** `price.nickname` is an optional field in Stripe — if you haven't set a nickname on the price, it returns `null`. More critically, if `subscription.items.data` is empty (edge case with metered billing setup), accessing `[0]` returns `undefined` and `.price` throws.
- **When it triggers:** Any subscription with a price that has no nickname set, or unusual subscription configurations.
- **Fix:** `subscription.items.data?.[0]?.price?.nickname ?? 'Unknown Plan'`

**7. `.env` contains live secret key with no `.gitignore`**
- **Where:** `.env:1` — `STRIPE_SECRET_KEY=sk_live_abc123`
- **What happens:** The `.env` file contains what appears to be a live Stripe secret key. There is no `.gitignore` in the project, meaning if this is (or ever becomes) a git repository, the secret key will be committed to version control.
- **When it triggers:** First `git init && git add .` or push to any remote.
- **Fix:** Create a `.gitignore` with `.env` in it. Rotate the Stripe key if it has ever been committed. Create a `.env.example` documenting required vars without values.

---

## Worth noting — Low risk but worth a look

**8. No process manager — server won't restart after crash**
- **Where:** `package.json:6` — `"start": "node server.js"`
- **What happens:** On a bare DigitalOcean droplet, `node server.js` runs as a foreground process. Any uncaught exception (which is likely given issues above) kills it permanently. No automatic restart, no log persistence.
- **When it triggers:** First unhandled error, or SSH session disconnect if not daemonised.
- **Fix:** Use pm2 (`pm2 start server.js --name stripe-sync`) or set up a systemd service unit. Add `pm2` to your deploy steps.

**9. No health check endpoint**
- **Where:** `server.js` — no `GET /health` or similar route
- **What happens:** No way to verify the server is up and processing correctly after deploy. You cannot set up monitoring or load balancer health checks.
- **Fix:** Add a simple `app.get('/health', (req, res) => res.json({ status: 'ok' }))`.

---

**Verdict:** This server has real security and reliability issues that will cause problems in production. The missing webhook signature verification is the most urgent — it is an open door for forged payment data. Combined with zero error handling and no idempotency, the server will crash on transient failures and create duplicate records on retries.

**Suggested next action:** Add Stripe webhook signature verification (issue #1) and wrap all async operations in try/catch (issue #2) before deploying. These two changes alone eliminate the most dangerous failure modes.

---

> Want me to fix any of these? Or should I run a deeper audit on a specific area?

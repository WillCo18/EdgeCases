## Edge Case Audit — Stripe-to-Airtable Webhook Sync — Pre-Deployment

**What I reviewed:** `server.js`, `package.json`, `.env`
**Build health:** Critical Issues

---

### What's solid
> - Clean separation of webhook handling and manual sync endpoint — good that both paths exist.
> - Correct conversion of Stripe amounts (dividing by 100) and Unix timestamps to ISO strings.
> - Using `dotenv` for configuration rather than hardcoding keys inline.

---

### Critical — Will break in production

**No Stripe webhook signature verification**
- **Where:** `server.js:12` — `app.post('/webhook/stripe', ...)`
- **What happens:** Anyone who knows your endpoint URL can POST fake payment events. An attacker can fabricate `checkout.session.completed` events to inject fraudulent records into your Airtable, or worse, trigger downstream business logic based on payments that never happened. Stripe strongly warns against this. Additionally, without signature verification you have no guarantee the payload hasn't been tampered with in transit.
- **Fix:** Use `stripe.webhooks.constructEvent()` with your webhook signing secret. This requires the raw request body, so you need `express.raw()` instead of `express.json()` on the webhook route:
  ```js
  app.post('/webhook/stripe', express.raw({ type: 'application/json' }), (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      console.error('Webhook signature verification failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }
    // ... handle event
  });
  ```

**No idempotency — Stripe retries will create duplicate Airtable records**
- **Where:** `server.js:16-31` — webhook handler for `checkout.session.completed`
- **What happens:** Stripe retries webhook deliveries if it doesn't get a 2xx response quickly enough (or on network hiccups). Each retry calls `base('Payments').create()` again with the same data, producing duplicate rows in Airtable. The same applies to the subscription handler. There is no check for whether an event or payment ID has already been processed.
- **Fix:** Store processed `event.id` values (Redis, a simple in-memory Set for low-volume, or an Airtable lookup) and skip duplicates:
  ```js
  const processed = new Set(); // minimum viable; use Redis for multi-instance
  // inside handler:
  if (processed.has(event.id)) return res.json({ received: true });
  // ... process event ...
  processed.add(event.id);
  ```
  For the Airtable side, query for existing `Payment ID` before creating.

**No error handling — unhandled promise rejection crashes the server**
- **Where:** `server.js:16-31` (webhook handler), `server.js:50-68` (`/sync/payments`)
- **What happens:** Every `await` in both route handlers is unwrapped — no try/catch, no `.catch()`. If the Airtable API returns a rate limit error, a network timeout, or Stripe's `customers.retrieve()` fails (e.g., deleted customer), the unhandled rejection will crash your Node process. On a bare DigitalOcean droplet without a process manager, the server stays down until you manually restart it.
- **Fix:** Wrap each handler body in try/catch and return appropriate status codes:
  ```js
  app.post('/webhook/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
    try {
      // ... event handling logic
      res.json({ received: true });
    } catch (err) {
      console.error('Webhook processing error:', err);
      res.status(500).json({ error: 'Processing failed' });
    }
  });
  ```

---

### High — Will bite you under realistic conditions

**`/sync/payments` endpoint is unauthenticated and creates duplicates on every call**
- **Where:** `server.js:48` — `app.get('/sync/payments', ...)`
- **What happens:** This endpoint is publicly accessible with no auth. Anyone (or any bot) hitting it creates up to 100 duplicate Airtable rows per request. Even legitimate use will duplicate records since there's no check against existing `Payment ID` values. It also only fetches the first page of results (Stripe paginates at 100), so it silently drops older payments.
- **Fix:** Add authentication (API key header check at minimum), deduplicate against existing Airtable records before creating, and use Stripe's auto-pagination to fetch all results:
  ```js
  app.get('/sync/payments', async (req, res) => {
    if (req.headers['x-api-key'] !== process.env.SYNC_API_KEY) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const payments = await stripe.paymentIntents.list({ limit: 100 });
    // use for await (const payment of stripe.paymentIntents.list({ limit: 100 }))
    // for auto-pagination
  });
  ```

**Null reference on `session.customer_details.email`**
- **Where:** `server.js:20` — `session.customer_details.email`
- **What happens:** `customer_details` can be `null` on checkout sessions where the customer wasn't required to provide an email (e.g., certain payment link configurations, or if the session is in a partial state). Accessing `.email` on `null` throws a TypeError and crashes the handler — Stripe retries, and you're stuck in a crash loop for that event.
- **Fix:** Use optional chaining and a fallback:
  ```js
  'Customer Email': session.customer_details?.email || 'unknown',
  ```

**Null reference on `subscription.items.data[0].price.nickname`**
- **Where:** `server.js:39` — `subscription.items.data[0].price.nickname`
- **What happens:** `price.nickname` is `null` by default in Stripe unless you explicitly set it when creating the price. This won't crash, but it will silently write `null` into your Airtable "Plan" field for every subscription, making the data useless. If you ever have a subscription with no items (edge case during creation), accessing `data[0]` throws.
- **Fix:**
  ```js
  'Plan': subscription.items?.data?.[0]?.price?.nickname || subscription.items?.data?.[0]?.price?.id || 'Unknown plan',
  ```

**No process manager — server won't restart after crash**
- **Where:** `package.json:6` — `"start": "node server.js"`
- **What happens:** On a bare DigitalOcean droplet, `node server.js` runs as a foreground process. Any unhandled error (see above) kills it permanently. There's no systemd service, no PM2, no Docker restart policy.
- **Fix:** Use PM2 or a systemd unit:
  ```bash
  npm install -g pm2
  pm2 start server.js --name stripe-sync
  pm2 startup  # generates systemd service
  pm2 save
  ```

**Live Stripe secret key in `.env` — likely committed to repo**
- **Where:** `.env:1` — `STRIPE_SECRET_KEY=sk_live_abc123`
- **What happens:** The `.env` file contains what appears to be a live Stripe secret key. If this repo is pushed to GitHub (even a private repo shared with collaborators), the key is exposed. There's no `.gitignore` visible in the project files.
- **When it triggers:** First `git push` if `.gitignore` doesn't exclude `.env`.
- **Fix:** Ensure `.gitignore` includes `.env`. Rotate the Stripe key immediately if it has been committed. On the droplet, set environment variables via the system environment or a secrets manager rather than a file deployed alongside code.

---

### Worth noting — Low risk but worth a look

**No health check endpoint**
- **Where:** `server.js` — no `GET /health` route
- **What happens:** DigitalOcean load balancers and uptime monitoring need a health endpoint. Without one, you can't easily tell if the server is running vs. hung.
- **Fix:** `app.get('/health', (req, res) => res.json({ status: 'ok' }));`

**Missing event types will silently drop important lifecycle changes**
- **Where:** `server.js:14-46` — only handles `checkout.session.completed` and `customer.subscription.created`
- **What happens:** `customer.subscription.updated`, `customer.subscription.deleted`, and `invoice.payment_failed` events are silently ignored. Subscription cancellations and failed renewals won't appear in your Airtable data, giving you an incomplete picture.
- **Fix:** Add handlers for at minimum `customer.subscription.updated` and `invoice.payment_failed`, or log unhandled event types so you know what you're missing.

**No timeout on outbound HTTP calls**
- **Where:** `server.js:36` — `stripe.customers.retrieve()`, all `base().create()` calls
- **What happens:** If Airtable's API stalls, your webhook handler hangs indefinitely. Stripe sees no response and retries, compounding the problem. The Stripe SDK has a default timeout but the Airtable SDK does not.
- **Fix:** Set a request timeout on the Airtable client or wrap calls in `Promise.race` with a timeout.

---

### Risk Summary

| # | Issue | Severity | Category |
|---|-------|----------|----------|
| 1 | No webhook signature verification | Critical | Security |
| 2 | No idempotency — retries create duplicates | Critical | Data integrity |
| 3 | No error handling — unhandled rejections crash server | Critical | Reliability |
| 4 | `/sync/payments` unauthenticated and creates duplicates | High | Security / Data integrity |
| 5 | Null reference on `customer_details.email` | High | Runtime crash |
| 6 | Null reference on `price.nickname` | High | Data quality |
| 7 | No process manager for production | High | Deployment |
| 8 | Live secret key likely committed to repo | High | Secrets |
| 9 | No health check endpoint | Worth noting | Deployment |
| 10 | Missing subscription lifecycle event types | Worth noting | Data completeness |
| 11 | No timeout on outbound Airtable calls | Worth noting | Reliability |

---

### Deployment Checklist

- [ ] Add Stripe webhook signature verification with `constructEvent()`
- [ ] Store processed `event.id` values to prevent duplicate records
- [ ] Wrap all route handlers in try/catch
- [ ] Add optional chaining for `session.customer_details?.email` and `price.nickname`
- [ ] Add authentication to `/sync/payments` endpoint
- [ ] Deduplicate `/sync/payments` against existing Airtable records
- [ ] Confirm `.env` is in `.gitignore` and rotate keys if previously committed
- [ ] Install PM2 or configure a systemd service on the droplet

---

**Verdict:** This server will accept forged events, create duplicate records on every Stripe retry, and crash on common null-reference cases with no automatic recovery. It needs the three critical fixes before it's safe to deploy.

**Suggested next action:** Start with webhook signature verification — it's the highest-impact fix and it changes how the request body is parsed (`express.raw` instead of `express.json`), which will require restructuring the top of the handler. The other fixes layer on top of that change.

---

Want me to rewrite the webhook handler with signature verification, idempotency checks, and proper error handling wired together? Those three fixes are interconnected and easiest to get right as a single pass.

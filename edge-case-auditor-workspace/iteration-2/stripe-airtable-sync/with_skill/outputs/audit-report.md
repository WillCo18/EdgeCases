## Edge Case Audit — Automation Pipeline (Webhook + Data Sync) — Pre-Deploy

**What I reviewed:**
- `server.js` — Express webhook handler and manual sync endpoint
- `package.json` — Dependencies and scripts
- `.env` — Environment configuration (secrets present)
- Project root — no `.gitignore`, no `.env.example`, no test files

**Build type:** Automation pipeline — Stripe webhook receiver + Airtable data sync
**Current phase:** Pre-deploy (deploying to DigitalOcean droplet)
**Key integrations:** Stripe (webhooks + API), Airtable (record creation)
**Risk surface:** Inbound webhooks from Stripe, outbound writes to Airtable, unauthenticated GET endpoint for manual sync

**Build health:** Critical Issues — multiple showstoppers that will cause data loss, security exposure, and crashes under normal production conditions.

---

### Critical — Will break in production

**1. Webhook signature not verified — anyone can forge Stripe events**
- **Where:** `server.js:12-13` — `app.post('/webhook/stripe', ...)`
- **What happens:** The handler reads `req.body` as parsed JSON and trusts it at face value. There is no call to `stripe.webhooks.constructEvent()` to verify the `Stripe-Signature` header. Any attacker who discovers the endpoint URL can POST fabricated events — creating fake payment records in Airtable, or triggering arbitrary Stripe API calls (e.g., the `stripe.customers.retrieve` on line 36).
- **When it triggers:** As soon as the endpoint is publicly reachable. Stripe webhook URLs are not secret; they can be guessed or discovered through DNS/port scanning.
- **Fix:** Use `express.raw()` instead of `express.json()` for the webhook route (Stripe needs the raw body to verify the signature), add a `STRIPE_WEBHOOK_SECRET` env var, and verify every event:
  ```js
  app.post('/webhook/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
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

**2. No error handling anywhere — a single Airtable failure crashes the server**
- **Where:** `server.js:18-29` — `base('Payments').create(...)`, `server.js:38-48` — `base('Subscriptions').create(...)`, `server.js:55-71` — entire `/sync/payments` handler
- **What happens:** Every `await` call (Airtable creates, Stripe API calls) is unwrapped with no try/catch. If Airtable returns a rate limit error (429), a network timeout, a field validation error, or any other failure, the unhandled promise rejection will crash the Express process. On the `/sync/payments` endpoint, a failure mid-loop leaves a partially-synced state with no indication of which records made it.
- **When it triggers:** Airtable's API has a 5 requests/second rate limit per base. The sequential loop in `/sync/payments` (lines 57-71) will exceed this almost immediately with 100 payments. Also triggers on any transient network error.
- **Fix:** Wrap all async operations in try/catch. For the webhook, catch errors and return 500 so Stripe knows to retry. For the sync loop, collect errors and report them:
  ```js
  try {
    await base('Payments').create([{ fields: { ... } }]);
  } catch (err) {
    console.error('Airtable write failed:', err.message);
    // For webhook: still return 200 to prevent infinite retries, but log for investigation
    // For sync: accumulate failures and report in response
  }
  ```

**3. Manual sync endpoint is completely unauthenticated and publicly accessible**
- **Where:** `server.js:54` — `app.get('/sync/payments', ...)`
- **What happens:** Anyone who hits `GET /sync/payments` triggers a full read of up to 100 payment intents from your live Stripe account and writes them all to Airtable. There is no auth check, no API key, no rate limiting. An attacker (or a search engine crawler, or a health check bot) can trigger this repeatedly, creating duplicate records on every request and racking up Airtable API calls.
- **When it triggers:** Immediately upon deployment. Any HTTP request to that path.
- **Fix:** At minimum, add a shared secret check:
  ```js
  app.get('/sync/payments', async (req, res) => {
    if (req.headers['authorization'] !== `Bearer ${process.env.SYNC_API_KEY}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    // ... rest of handler
  });
  ```

**4. No idempotency — duplicate records created on every webhook retry and every sync run**
- **Where:** `server.js:18-29` — `base('Payments').create(...)`, `server.js:38-48` — `base('Subscriptions').create(...)`, `server.js:59-69` — sync loop `create()`
- **What happens:** Every call uses Airtable's `create()` which always inserts new records. Stripe retries webhooks up to ~15 times if it doesn't get a timely 2xx response. Each retry creates another duplicate row. The `/sync/payments` endpoint creates duplicates every time it's called — there is no check for whether a `Payment ID` already exists in Airtable.
- **When it triggers:** Stripe retries (which happen whenever your server is slow, restarts, or returns an error); any repeated call to `/sync/payments`; any network hiccup that causes Stripe to re-deliver.
- **Fix:** Before creating a record, query Airtable to check if a record with that `Payment ID` or `Subscription ID` already exists. Alternatively, store processed `event.id` values and skip duplicates:
  ```js
  const existing = await base('Payments').select({
    filterByFormula: `{Payment ID} = '${session.payment_intent}'`,
    maxRecords: 1
  }).firstPage();
  if (existing.length === 0) {
    await base('Payments').create([{ fields: { ... } }]);
  }
  ```

**5. Null reference crash on `session.customer_details.email`**
- **Where:** `server.js:21` — `session.customer_details.email`
- **What happens:** `customer_details` can be `null` on a `checkout.session.completed` event if the session was created without collecting customer details (e.g., payment links where email collection is optional, or sessions created via the API without `customer_email`). Accessing `.email` on `null` throws `TypeError: Cannot read properties of null`, crashing the server.
- **When it triggers:** Any checkout session where Stripe doesn't collect customer details.
- **Fix:** Use optional chaining: `session.customer_details?.email || 'unknown'`

---

### High — Will bite you under realistic conditions

**6. `price.nickname` is frequently null — Airtable gets a null Plan value**
- **Where:** `server.js:42` — `subscription.items.data[0].price.nickname`
- **What happens:** `price.nickname` is an optional field in Stripe. Many prices don't have a nickname set — it defaults to `null`. This writes `null` into the Airtable `Plan` field. If the Airtable field is configured as a required field or a single-select, this will throw an error. Even if it doesn't throw, your Airtable data will have blank Plan values, making it useless for filtering.
- **When it triggers:** Any subscription where the Stripe price doesn't have a nickname configured.
- **Fix:** Fall back to a meaningful identifier: `subscription.items.data[0].price.nickname || subscription.items.data[0].price.id`

**7. Stripe pagination ignored — sync only gets the first 100 payments**
- **Where:** `server.js:55` — `stripe.paymentIntents.list({ limit: 100 })`
- **What happens:** Stripe's `list()` returns a paginated response. The code reads only the first page (max 100 records) and stops. If you have more than 100 payment intents, the rest are silently dropped — no error, no indication of missing data.
- **When it triggers:** As soon as your Stripe account has more than 100 payment intents.
- **Fix:** Use Stripe's auto-pagination:
  ```js
  const payments = await stripe.paymentIntents.list({ limit: 100 });
  for await (const payment of stripe.paymentIntents.list({ limit: 100 })) {
    // process each payment
  }
  ```

**8. Missing critical Stripe event types — subscription updates and payment failures not handled**
- **Where:** `server.js:12-52` — webhook handler only handles `checkout.session.completed` and `customer.subscription.created`
- **What happens:** The handler does not process `customer.subscription.updated` (plan changes, cancellations), `customer.subscription.deleted`, or `invoice.payment_failed`. Airtable will show subscriptions as permanently active even after they're cancelled or past-due. Payment failures won't be tracked at all.
- **When it triggers:** The first time a customer cancels, changes plan, or has a payment fail.
- **Fix:** Add handlers for at least: `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`. For updates/deletes, query for the existing Airtable record by Subscription ID and update it rather than creating a new one.

**9. No request timeout on outbound calls — server hangs if Stripe or Airtable stalls**
- **Where:** `server.js:36` — `stripe.customers.retrieve(...)`, `server.js:55` — `stripe.paymentIntents.list(...)`, all `base().create()` calls
- **What happens:** Neither the Stripe client nor the Airtable client has a timeout configured. If Stripe or Airtable's API hangs (which happens during outages), the request handler hangs indefinitely, consuming a connection. Under load, this exhausts all available connections and the server becomes unresponsive.
- **When it triggers:** During any upstream API outage or network partition.
- **Fix:** Configure timeouts on the Stripe client:
  ```js
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
    timeout: 10000, // 10 seconds
  });
  ```
  For Airtable, wrap calls in a `Promise.race` with a timeout, or use `AbortController`.

**10. Server listens on port 3000 with no TLS — secrets transmitted in cleartext**
- **Where:** `server.js:76` — `app.listen(3000, ...)`
- **What happens:** The server runs plain HTTP. If you point Stripe webhooks directly at `http://your-droplet:3000/webhook/stripe`, webhook payloads (containing customer emails, payment amounts) traverse the internet unencrypted. Stripe requires HTTPS for webhook endpoints in live mode.
- **When it triggers:** Immediately on deployment. Stripe will refuse to send live webhooks to an HTTP endpoint.
- **Fix:** Put the Express server behind a reverse proxy (nginx or Caddy) with a TLS certificate (Let's Encrypt). Caddy is the simplest option for a single-droplet deployment as it handles cert provisioning automatically.

**11. No `.gitignore` — `.env` with live Stripe secret key will be committed**
- **Where:** Project root — no `.gitignore` file present; `.env` contains `sk_live_abc123`
- **What happens:** Without a `.gitignore`, a `git add .` will commit the `.env` file containing your live Stripe secret key and Airtable API key. Once in git history, removing it from the working tree is not enough — it remains in the commit log.
- **When it triggers:** First `git commit` that includes all files.
- **Fix:** Create a `.gitignore`:
  ```
  node_modules/
  .env
  ```
  If the `.env` has already been committed, rotate all keys immediately and use `git filter-branch` or BFG Repo-Cleaner to purge it from history.

**12. No process manager — server dies on first unhandled error and stays dead**
- **Where:** `package.json:6` — `"start": "node server.js"`
- **What happens:** Running `node server.js` directly means any unhandled exception kills the process with no restart. On a bare DigitalOcean droplet, the server stays down until someone manually SSHs in and restarts it.
- **When it triggers:** First unhandled error (which, given the lack of try/catch blocks, will happen quickly).
- **Fix:** Use PM2 or systemd to manage the process:
  ```bash
  npm install -g pm2
  pm2 start server.js --name stripe-sync
  pm2 startup  # auto-start on reboot
  pm2 save
  ```

---

### Worth noting — Low risk but worth a look

**13. Airtable rate limit will throttle the sync endpoint**
- **Where:** `server.js:57-71` — sequential loop creating one record at a time
- **What happens:** Airtable allows 5 API requests per second per base. The loop fires sequential `create()` calls with no delay or batching. With 100 payments, you'll hit the rate limit within seconds and get 429 errors (which, per issue #2, will crash the server). Even with error handling, the sync will be very slow.
- **When it triggers:** Any call to `/sync/payments` with more than a handful of records.
- **Fix:** Airtable's `create()` accepts up to 10 records per call. Batch records in groups of 10 and add a small delay between batches:
  ```js
  const batch = payments.data.filter(p => p.status === 'succeeded');
  for (let i = 0; i < batch.length; i += 10) {
    const chunk = batch.slice(i, i + 10).map(p => ({ fields: { ... } }));
    await base('Payments').create(chunk);
    await new Promise(r => setTimeout(r, 250)); // respect rate limit
  }
  ```

**14. No `.env.example` — next developer has no idea what env vars are required**
- **Where:** Project root — no `.env.example` file
- **What happens:** There's no documentation of which environment variables the app needs. A new developer (or a deploy script) will have to read the source to figure out `STRIPE_SECRET_KEY`, `AIRTABLE_API_KEY`, and `AIRTABLE_BASE_ID` are required. Missing any of them will cause a cryptic runtime error rather than a clear startup message.
- **Fix:** Create `.env.example`:
  ```
  STRIPE_SECRET_KEY=sk_test_...
  STRIPE_WEBHOOK_SECRET=whsec_...
  AIRTABLE_API_KEY=pat...
  AIRTABLE_BASE_ID=app...
  ```

**15. No health check endpoint — no way to verify the server is alive**
- **Where:** `server.js` — no `/health` or `/` route defined
- **What happens:** After deploying, there's no way to programmatically check if the server is running. Uptime monitors, load balancers, and deploy scripts have nothing to ping.
- **When it triggers:** When you want to set up monitoring or a reverse proxy health check.
- **Fix:** Add a simple health endpoint:
  ```js
  app.get('/health', (req, res) => res.json({ status: 'ok' }));
  ```

**16. No logging beyond console.log — no structured logging, no error tracking**
- **Where:** `server.js:31` — `console.log(...)` is the only logging
- **What happens:** Only the happy path for `checkout.session.completed` logs anything. Subscription events, sync operations, and all errors produce no log output. On a droplet, `console.log` output goes to stdout and is lost unless captured. Debugging production issues will be nearly impossible.
- **When it triggers:** First time something goes wrong and you need to investigate.
- **Fix:** At minimum, add error logging in catch blocks and use PM2's log management. For production, consider a structured logger like `pino` or `winston`.

**17. `STRIPE_WEBHOOK_SECRET` not in `.env` — even after adding signature verification, the secret is missing**
- **Where:** `.env` — only contains `STRIPE_SECRET_KEY`, `AIRTABLE_API_KEY`, `AIRTABLE_BASE_ID`
- **What happens:** When you add webhook signature verification (issue #1), you'll need `STRIPE_WEBHOOK_SECRET` from your Stripe dashboard. It's not in the current env config, so the fix for #1 won't work until this is also added.
- **Fix:** Get the webhook signing secret from Stripe Dashboard > Webhooks > your endpoint > Signing secret, and add it to `.env`.

---

### Risk Summary

| # | Issue | Severity | Category |
|---|-------|----------|----------|
| 1 | Webhook signature not verified | Critical | Security |
| 2 | No error handling — unhandled rejections crash server | Critical | Reliability |
| 3 | `/sync/payments` endpoint unauthenticated | Critical | Security |
| 4 | No idempotency — duplicate records on retries | Critical | Data Integrity |
| 5 | Null reference crash on `customer_details.email` | Critical | Reliability |
| 6 | `price.nickname` frequently null | High | Data Integrity |
| 7 | Stripe pagination ignored — only first 100 payments synced | High | Data Integrity |
| 8 | Missing critical Stripe event types | High | Completeness |
| 9 | No request timeouts on outbound calls | High | Reliability |
| 10 | No TLS — plain HTTP on public internet | High | Security |
| 11 | No `.gitignore` — live secrets will be committed | High | Security |
| 12 | No process manager — no auto-restart on crash | High | Reliability |
| 13 | Airtable rate limit will throttle sync endpoint | Worth noting | Reliability |
| 14 | No `.env.example` | Worth noting | Developer Experience |
| 15 | No health check endpoint | Worth noting | Operability |
| 16 | No structured logging or error tracking | Worth noting | Operability |
| 17 | `STRIPE_WEBHOOK_SECRET` missing from env config | Worth noting | Configuration |

---

### Deployment Checklist

Before deploying, verify:
- [ ] Add Stripe webhook signature verification with `constructEvent()` (issue #1)
- [ ] Wrap all async operations in try/catch blocks (issue #2)
- [ ] Add authentication to `/sync/payments` endpoint (issue #3)
- [ ] Add idempotency checks before Airtable `create()` calls (issue #4)
- [ ] Add null-safe access for `session.customer_details` (issue #5)
- [ ] Fall back to `price.id` when `price.nickname` is null (issue #6)
- [ ] Implement Stripe auto-pagination for sync endpoint (issue #7)
- [ ] Add handlers for subscription update/delete and payment failure events (issue #8)
- [ ] Configure timeouts on Stripe and Airtable API calls (issue #9)
- [ ] Set up a reverse proxy with TLS (nginx + certbot, or Caddy) (issue #10)
- [ ] Create `.gitignore` excluding `.env` and `node_modules/` (issue #11)
- [ ] Install PM2 or configure systemd for process management (issue #12)
- [ ] Add `STRIPE_WEBHOOK_SECRET` to environment variables (issue #17)

---

**Verdict:** This server will not survive production deployment in its current state. The combination of no webhook signature verification, no error handling, and no idempotency means it will accept forged events, crash on the first Airtable hiccup, and create duplicate records on every Stripe retry. The core data sync logic is sound, but the production hardening layer is entirely missing.

**Suggested next action:** Add webhook signature verification (issue #1) first. It's the highest-impact fix — without it, the endpoint is effectively a public API that writes arbitrary data to your Airtable base. Then add try/catch around all async calls (issue #2) so the server stops crashing on transient errors.

---

> Want me to fix any of these? Or should I run a deeper audit on a specific area?

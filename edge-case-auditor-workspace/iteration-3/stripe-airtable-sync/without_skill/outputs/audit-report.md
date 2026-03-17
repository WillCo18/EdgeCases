# Audit: Stripe-to-Airtable Webhook Sync Server

You asked "what could go wrong?" -- quite a lot, actually. Let me walk through the issues I see, roughly ordered from most critical to least.

---

## 1. No Stripe Webhook Signature Verification (Critical Security Issue)

This is the single biggest problem. Your `/webhook/stripe` endpoint accepts any POST body and trusts it as a legitimate Stripe event. Anyone who discovers your endpoint URL can send fabricated events -- fake payments, fake subscriptions, whatever they want -- and your server will happily write them to Airtable.

Stripe provides a webhook signing secret (`whsec_...`) and a `stripe.webhooks.constructEvent()` method specifically for this. You need to:

- Use `express.raw({ type: 'application/json' })` instead of `express.json()` so you get the raw body for signature verification.
- Verify the `Stripe-Signature` header against your webhook signing secret.

Without this, your system is trivially exploitable. This should be a deployment blocker.

## 2. Live Secret Key in `.env` File

Your `.env` file contains what appears to be a live Stripe secret key (`sk_live_abc123`). A few concerns:

- If this repo is or ever gets pushed to GitHub (even accidentally), that key is compromised. Stripe monitors for this and will revoke it, but the window of exposure is dangerous.
- On your DigitalOcean droplet, make sure `.env` is not world-readable. Set file permissions appropriately (`chmod 600 .env`).
- Better yet, use DigitalOcean's environment variable configuration or a secrets manager rather than a `.env` file on disk.

Also make sure `.env` is in your `.gitignore` -- I don't see a `.gitignore` file in the project.

## 3. No Error Handling Anywhere

Every `await` call in this server can throw, and none of them are wrapped in try/catch. If the Airtable API is down, rate-limited, or returns an error, your webhook handler will crash and return a 500 to Stripe. Stripe will then retry the webhook -- which is good -- but if the error is persistent (e.g., a malformed field), you'll get stuck in a retry loop.

Specific failure points:
- `base('Payments').create(...)` -- Airtable could be down, rate-limited (5 requests/sec), or reject your field names.
- `stripe.customers.retrieve(subscription.customer)` -- the Stripe API call could fail.
- `session.customer_details.email` -- could be `null` if the checkout session didn't collect email.
- `subscription.items.data[0].price.nickname` -- `nickname` can be `null` if you didn't set one on the price. `items.data[0]` could theoretically be undefined.

You should wrap your handler logic in try/catch, log errors properly, and still return a 200 to Stripe (so it doesn't keep retrying events you can't process).

## 4. The `/sync/payments` Endpoint is Dangerous

This unauthenticated GET endpoint will:
- Fetch up to 100 payments from Stripe and create new Airtable records for each one -- **every time it's called**.
- There's no deduplication. If someone (or a bot) hits this endpoint 10 times, you get 10x duplicate records in Airtable.
- There's no authentication. Anyone who finds this URL can trigger it.
- It only fetches the first 100 payments (no pagination), so it won't actually sync everything.
- Each Airtable create is done sequentially in a `for` loop with `await`, so for 100 payments this will be very slow and could easily time out.

This endpoint needs at minimum: authentication, idempotency/deduplication, and pagination. Or honestly, consider removing it and building a proper backfill script that runs locally instead of exposing it as an HTTP endpoint.

## 5. No Idempotency / Duplicate Protection

Stripe explicitly states that webhooks can be delivered more than once. Your handler has no mechanism to detect or prevent duplicate processing. If Stripe retries a `checkout.session.completed` event (because your server was slow to respond, or returned a 5xx), you'll get duplicate rows in Airtable.

You should either:
- Track processed event IDs (in Airtable, a database, or even a simple in-memory Set for short-term dedup).
- Use Airtable's duplicate detection by checking for existing records with the same Payment ID before creating.

## 6. No HTTPS / TLS

Stripe requires webhook endpoints to use HTTPS in production. Your Express server is listening on plain HTTP port 3000. On your DigitalOcean droplet, you'll need either:
- A reverse proxy like Nginx or Caddy in front of your app with TLS termination (Let's Encrypt is free).
- Or a service like Cloudflare in front.

Without HTTPS, Stripe won't let you register the webhook endpoint for live mode, and even if it did, your Stripe secret key and Airtable API key would be flowing over unencrypted connections.

## 7. No Process Management

`node server.js` will exit if it crashes (unhandled exception, out of memory, etc.) and won't restart. On a DigitalOcean droplet you need:
- A process manager like PM2, or a systemd service, to keep the process alive.
- Something to handle log rotation (your `console.log` output will need to go somewhere persistent).

## 8. Airtable Rate Limits

Airtable's API has a rate limit of 5 requests per second per base. Your webhook handler makes one create call per event, which is fine for low volume. But:
- If you get a burst of checkout completions (e.g., a product launch), you'll hit the rate limit quickly.
- The `/sync/payments` endpoint makes one call per payment sequentially -- 100 calls could take 20+ seconds and will definitely hit rate limits.

Consider batching Airtable creates (the API supports up to 10 records per create call) and adding retry logic with backoff.

## 9. No Logging or Monitoring

You have one `console.log` for successful payment syncs and nothing else. In production you'll want:
- Structured logging (e.g., with pino or winston) so you can search and filter logs.
- Error logging with enough context to debug issues.
- Some form of alerting if the webhook starts failing (even a simple health check endpoint that an uptime monitor can hit).

## 10. Missing `.gitignore`

I don't see a `.gitignore` in your project. You should have one that at minimum excludes:
```
node_modules/
.env
```

## 11. No Input Validation on Event Data

You're accessing nested properties like `session.customer_details.email` and `subscription.items.data[0].price.nickname` without any null checks. Stripe event payloads can vary -- for example, `customer_details` might be null if the session was created without collecting customer info. This will throw a TypeError and crash your handler.

## 12. Hardcoded Port

Port 3000 is hardcoded. Minor issue, but you should use `process.env.PORT || 3000` so it's configurable on the droplet.

---

## Summary of Recommendations Before Deploying

| Priority | Action |
|----------|--------|
| **Blocker** | Add Stripe webhook signature verification |
| **Blocker** | Add HTTPS (Nginx/Caddy + Let's Encrypt) |
| **Blocker** | Add `.gitignore` and ensure `.env` is excluded |
| **High** | Wrap all async operations in try/catch |
| **High** | Add authentication to `/sync/payments` or remove it |
| **High** | Add idempotency checks to prevent duplicate records |
| **High** | Set up PM2 or systemd for process management |
| **Medium** | Add null checks for event payload fields |
| **Medium** | Add proper logging |
| **Medium** | Handle Airtable rate limits with batching/retry |
| **Low** | Make port configurable via environment variable |
| **Low** | Add a health check endpoint |

The two absolute blockers are the missing webhook signature verification and the lack of HTTPS. Without those, you're deploying an unauthenticated endpoint that accepts fabricated data over an unencrypted connection. Everything else is important but those two should stop you from going live.

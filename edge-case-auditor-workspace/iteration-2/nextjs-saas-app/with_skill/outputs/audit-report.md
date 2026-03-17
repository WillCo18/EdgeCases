# Edge Case Audit — Next.js SaaS App — Pre-Deploy

**What I reviewed:**
- `app/api/webhook/route.ts` — Stripe webhook handler
- `app/api/auth/route.ts` — Authentication endpoint
- `app/api/cron/route.ts` — Daily subscription check cron job
- `app/dashboard/page.tsx` — Dashboard server component
- `lib/supabase.ts` — Supabase client setup
- `package.json` — Dependencies
- `.env.local` — Environment configuration

**Build type:** Next.js SaaS app with Stripe billing, Supabase backend, Resend email, Vercel Cron
**Current phase:** Pre-deploy
**Key integrations:** Supabase (auth + DB), Stripe (billing + webhooks), Resend (transactional email), Vercel Cron
**Risk surface:** Stripe webhook ingress, public API routes, cron job, client-side Supabase queries, session tokens in API responses

**Build health:** Critical Issues

---

## Critical — Will break in production

**1. Stripe webhook uses `.insert()` instead of `.upsert()` — duplicate webhook deliveries will crash**
- **Where:** `app/api/webhook/route.ts:21` — `checkout.session.completed` handler
- **What happens:** Stripe guarantees at-least-once delivery for webhooks. When Stripe retries a `checkout.session.completed` event (network blip, slow response, Stripe's own retry logic), the `.insert()` call will attempt to create a duplicate row. If there's a unique constraint on `stripe_subscription_id` or `user_id + plan`, it throws a Postgres duplicate key error and returns a 500 to Stripe, which triggers more retries — creating a retry storm. If there's no unique constraint, you get duplicate subscription records and the user sees multiple subscriptions on their dashboard.
- **When it triggers:** Any webhook retry from Stripe, which happens routinely in production.
- **Fix:** Use `.upsert()` with a conflict target, or check for existence first:
  ```ts
  await supabaseAdmin.from('subscriptions').upsert({
    user_id: session.metadata.userId,
    stripe_customer_id: session.customer,
    stripe_subscription_id: session.subscription,
    plan: session.metadata.plan,
    status: 'active',
    current_period_end: new Date(stripeSub.current_period_end * 1000).toISOString()
  }, { onConflict: 'stripe_subscription_id' });
  ```

**2. Dashboard server component crashes on null subscription — every new/free user sees an error page**
- **Where:** `app/dashboard/page.tsx:28-30` — accessing `subscription.plan`, `subscription.status`, `subscription.current_period_end`
- **What happens:** The `.single()` query on line 10-14 returns `null` when a user has no subscription (new user, free tier, cancelled user). Lines 28-30 access `.plan`, `.status`, and `.current_period_end` on `null`, causing a runtime crash. In Next.js server components, this renders a 500 error page — breaking the dashboard for every user without an active subscription.
- **When it triggers:** Any user who hasn't completed checkout, is on a free tier, or whose subscription was deleted.
- **Fix:** Null-check the subscription before rendering:
  ```tsx
  {subscription ? (
    <div>
      <h2>Subscription</h2>
      <p>Plan: {subscription.plan}</p>
      <p>Status: {subscription.status}</p>
      <p>Renews: {new Date(subscription.current_period_end).toLocaleDateString()}</p>
    </div>
  ) : (
    <div><h2>No active subscription</h2><p>Choose a plan to get started.</p></div>
  )}
  ```

**3. Dashboard `supabase.auth.getUser()` will always return null in server component — no user ever sees their data**
- **Where:** `app/dashboard/page.tsx:4` — `supabase.auth.getUser()`
- **What happens:** The `supabase` client in `lib/supabase.ts` is created with `createClient()` from `@supabase/supabase-js`, which has no access to cookies or headers in a Next.js server component. `getUser()` requires the user's auth token, which lives in a cookie. Without using `@supabase/ssr` and `createServerClient` with cookie access, `getUser()` always returns `{ data: { user: null } }`. Every user sees "Please log in" even when authenticated.
- **When it triggers:** Every single page load of the dashboard.
- **Fix:** Use `@supabase/ssr` (already in `package.json`) to create a server-side client with cookie access:
  ```ts
  import { createServerClient } from '@supabase/ssr';
  import { cookies } from 'next/headers';

  export function createSupabaseServer() {
    const cookieStore = cookies();
    return createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { cookies: { get: (name) => cookieStore.get(name)?.value } }
    );
  }
  ```

**4. Cron endpoint has no authentication — anyone can trigger it via GET request**
- **Where:** `app/api/cron/route.ts:10` — `GET(req: Request)`
- **What happens:** The cron endpoint is a public GET route with no authentication check. Anyone who discovers the URL (e.g., `/api/cron`) can trigger the subscription check, mass-email users, and hammer the Stripe API. Vercel Cron sends an `Authorization: Bearer <CRON_SECRET>` header that should be verified.
- **When it triggers:** Any unauthenticated HTTP request to `/api/cron`.
- **Fix:** Verify the `CRON_SECRET` header:
  ```ts
  export async function GET(req: Request) {
    const authHeader = req.headers.get('authorization');
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    // ... rest of handler
  }
  ```

**5. Session token returned in API response body — exposed to XSS**
- **Where:** `app/api/auth/route.ts:16` — `return NextResponse.json({ user: data.user, session: data.session })`
- **What happens:** The full Supabase session object (including `access_token` and `refresh_token`) is returned in the JSON response body. If any XSS vulnerability exists anywhere in the app, an attacker can steal the session token. Tokens should be set as HttpOnly cookies, not returned in response bodies.
- **When it triggers:** Every successful login.
- **Fix:** Use Supabase SSR's cookie-based auth flow instead of returning tokens in the response body. The `@supabase/ssr` package handles this correctly by setting HttpOnly cookies.

**6. Hardcoded period end date instead of using Stripe's actual value**
- **Where:** `app/api/webhook/route.ts:27` — `new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)`
- **What happens:** The subscription's `current_period_end` is calculated as "now + 30 days" instead of using Stripe's actual `current_period_end` from the subscription object. This will be wrong for yearly plans, trial periods, prorated subscriptions, and any plan that isn't exactly 30 days. The cron job later compares against this value to determine expiry, so incorrect dates mean premature expiry emails or missed expirations.
- **When it triggers:** Any subscription that isn't a simple monthly plan, or any checkout that completes with a trial period.
- **Fix:** Retrieve the subscription from Stripe to get the real period end:
  ```ts
  const subscription = await stripe.subscriptions.retrieve(session.subscription as string);
  // Use: new Date(subscription.current_period_end * 1000).toISOString()
  ```

---

## High — Will bite you under realistic conditions

**7. Supabase admin client (`service_role` key) is importable from client-side code**
- **Where:** `lib/supabase.ts:8-11` — `supabaseAdmin` export
- **What happens:** Both `supabase` (anon) and `supabaseAdmin` (service role) are exported from the same module. The service role key bypasses all Row Level Security. If any client component imports from `@/lib/supabase`, the bundler may include the service role key in the client JavaScript bundle, exposing full admin access to your database.
- **When it triggers:** Any client component that imports from `lib/supabase.ts`, even if it only uses the `supabase` export.
- **Fix:** Split into separate files and protect the admin module:
  ```ts
  // lib/supabase.ts (client-safe)
  import { createClient } from '@supabase/supabase-js';
  export const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );

  // lib/supabase-admin.ts (server-only)
  import 'server-only';
  import { createClient } from '@supabase/supabase-js';
  export const supabaseAdmin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
  ```

**8. Auth route has no input validation — malformed body crashes the endpoint**
- **Where:** `app/api/auth/route.ts:5` — `const { email, password } = await req.json()`
- **What happens:** If the request body is not valid JSON, `req.json()` throws an unhandled exception and returns a 500. If the body is valid JSON but missing `email` or `password`, `undefined` is passed to Supabase which produces confusing error messages. No length, format, or type validation is performed.
- **When it triggers:** Any malformed request, bot traffic, or API fuzzing.
- **Fix:** Wrap in try/catch and validate inputs:
  ```ts
  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const { email, password } = body;
  if (!email || !password) {
    return NextResponse.json({ error: 'Email and password required' }, { status: 400 });
  }
  ```

**9. Cron job has no error handling — one failed Stripe call aborts the entire run**
- **Where:** `app/api/cron/route.ts:23` — `stripe.subscriptions.retrieve()` inside the for loop
- **What happens:** The `for` loop iterates over all expiring subscriptions sequentially. If `stripe.subscriptions.retrieve()` throws for one subscription (invalid ID, Stripe outage, rate limit), the entire cron job aborts with an unhandled exception. Remaining subscriptions are never checked. The Resend email call on line 40 is similarly unprotected.
- **When it triggers:** Stripe API transient error, rate limit (100 requests/second), or a deleted/invalid subscription ID in the database.
- **Fix:** Wrap the loop body in try/catch and continue on failure:
  ```ts
  for (const sub of expiring) {
    try {
      const stripeSub = await stripe.subscriptions.retrieve(sub.stripe_subscription_id);
      // ... rest of logic
    } catch (err) {
      console.error(`Failed to process subscription ${sub.id}:`, err);
      continue;
    }
  }
  ```

**10. Cron job will hit Stripe rate limits with many expiring subscriptions**
- **Where:** `app/api/cron/route.ts:21-46` — sequential Stripe API calls in loop
- **What happens:** Each subscription requires a `stripe.subscriptions.retrieve()` call, and expired ones also trigger an email. With hundreds of expiring subscriptions, sequential API calls will easily exceed Vercel's function timeout (10s on Hobby, 60s on Pro) and may hit Stripe rate limits. There's no batching or pagination.
- **When it triggers:** When you have more than a handful of subscriptions expiring on the same day.
- **Fix:** Process in batches, add concurrency control, and consider pagination on the Supabase query. Also add a `.limit()` to the Supabase query to prevent unbounded result sets.

**11. Webhook handler ignores Supabase errors — data operations fail silently**
- **Where:** `app/api/webhook/route.ts:21-28` and `34-37` — `.insert()` and `.update()` calls
- **What happens:** Neither the `.insert()` nor the `.update()` call checks the Supabase response for errors. If the database operation fails (connection issue, constraint violation, RLS policy denial), the webhook returns `200 { received: true }` to Stripe, which considers the event delivered and won't retry. The subscription data is silently lost.
- **When it triggers:** Any database error during webhook processing.
- **Fix:** Check the error response and return a 500 to trigger Stripe retry:
  ```ts
  const { error } = await supabaseAdmin.from('subscriptions').insert({...});
  if (error) {
    console.error('Failed to insert subscription:', error);
    return NextResponse.json({ error: 'Database error' }, { status: 500 });
  }
  ```

**12. No rate limiting on auth endpoint — brute force attacks possible**
- **Where:** `app/api/auth/route.ts` — entire file
- **What happens:** The login endpoint has no rate limiting. An attacker can make unlimited password attempts. While Supabase has its own rate limiting, it may not be restrictive enough for a login endpoint, and you have no visibility into or control over those limits.
- **When it triggers:** Any automated attack against user accounts.
- **Fix:** Add rate limiting via Vercel's built-in `@vercel/edge` rate limiting, or use an `upstash/ratelimit` with Redis.

**13. Webhook doesn't handle `customer.subscription.updated` event**
- **Where:** `app/api/webhook/route.ts` — only handles `checkout.session.completed` and `customer.subscription.deleted`
- **What happens:** When a customer upgrades, downgrades, or their subscription renews, Stripe sends `customer.subscription.updated`. This event is ignored, so plan changes, renewals, and billing cycle updates are never reflected in the database. The local `current_period_end` and `plan` become permanently stale after the first billing cycle.
- **When it triggers:** Every subscription renewal, plan change, or payment method update.
- **Fix:** Add a handler for `customer.subscription.updated`:
  ```ts
  if (event.type === 'customer.subscription.updated') {
    const subscription = event.data.object as Stripe.Subscription;
    await supabaseAdmin.from('subscriptions').update({
      status: subscription.status === 'active' ? 'active' : subscription.status,
      plan: subscription.items.data[0]?.price.lookup_key,
      current_period_end: new Date(subscription.current_period_end * 1000).toISOString()
    }).eq('stripe_subscription_id', subscription.id);
  }
  ```

---

## Worth noting — Low risk but worth a look

**14. No `.env.example` file — deployment will miss environment variables**
- **Where:** Project root — missing `.env.example`
- **What happens:** Without a documented list of required env vars, deploying to Vercel means guessing which variables need to be set. Easy to miss `RESEND_API_KEY` or `STRIPE_WEBHOOK_SECRET` and get cryptic runtime errors.
- **When it triggers:** First deployment, or when onboarding a new developer.
- **Fix:** Create a `.env.example` listing all required variables (without values).

**15. Missing `vercel.json` for cron schedule**
- **Where:** Project root — missing `vercel.json`
- **What happens:** The cron endpoint at `/api/cron` exists but Vercel has no configuration to call it automatically. Without a `vercel.json` defining the cron schedule, the endpoint is never invoked by Vercel's cron system.
- **When it triggers:** After deployment — the cron job simply never runs.
- **Fix:** Add a `vercel.json`:
  ```json
  {
    "crons": [
      { "path": "/api/cron", "schedule": "0 0 * * *" }
    ]
  }
  ```

**16. Missing TypeScript devDependencies — build may fail on Vercel**
- **Where:** `package.json` — no `devDependencies` section
- **What happens:** `typescript`, `@types/react`, and `@types/node` are not listed in `package.json`. The build may work locally if these are installed globally, but Vercel installs from `package.json` only. The build could fail with cryptic TypeScript errors.
- **When it triggers:** First Vercel deployment.
- **Fix:** Add devDependencies:
  ```json
  "devDependencies": {
    "typescript": "^5",
    "@types/react": "^18",
    "@types/node": "^20"
  }
  ```

**17. Cron job uses `.env`-hardcoded sender address**
- **Where:** `app/api/cron/route.ts:41` — `from: 'noreply@myapp.com'`
- **What happens:** The `from` address is hardcoded as `noreply@myapp.com`. If your Resend verified domain is different, emails will fail to send. This should be an environment variable.
- **When it triggers:** When the Resend domain doesn't match `myapp.com`.
- **Fix:** Use an env var: `from: process.env.EMAIL_FROM || 'noreply@myapp.com'`

**18. HTML injection in expiry notification email**
- **Where:** `app/api/cron/route.ts:44` — `${sub.users.name}` interpolated directly into HTML
- **What happens:** The user's `name` field from the database is injected directly into an HTML email template without escaping. If a user's name contains HTML or script tags, it could render unexpected content in email clients that render HTML.
- **When it triggers:** A user with HTML characters in their name receives an expiry email.
- **Fix:** Escape the user name before interpolation, or use a templating library that auto-escapes.

**19. `.env.local` contains what appears to be a live Stripe key (`sk_live_`)**
- **Where:** `.env.local:4` — `STRIPE_SECRET_KEY=sk_live_xxxxx`
- **What happens:** The key prefix `sk_live_` indicates this is a production Stripe key, not a test key (`sk_test_`). If `.env.local` is committed to git (no evidence of `.gitignore` in the project), the live key is exposed. Even if not committed, using a live key in local development means test actions create real charges.
- **When it triggers:** Local development — real money is charged for test operations.
- **Fix:** Use `sk_test_` keys for local development. Ensure `.env.local` is in `.gitignore`.

---

## Risk Summary

| # | Issue | Severity | Category |
|---|-------|----------|----------|
| 1 | Webhook `.insert()` fails on retry — no idempotency | Critical | Reliability / Data Integrity |
| 2 | Dashboard crashes on null subscription | Critical | Reliability / UX |
| 3 | `getUser()` always returns null in server component | Critical | Auth / UX |
| 4 | Cron endpoint publicly accessible — no auth | Critical | Security |
| 5 | Session tokens returned in response body | Critical | Security |
| 6 | Hardcoded period end instead of Stripe's actual value | Critical | Data Integrity |
| 7 | Service role key exposed to client bundle | High | Security |
| 8 | Auth route has no input validation | High | Security / Reliability |
| 9 | Cron job aborts on single Stripe API failure | High | Reliability |
| 10 | Cron job will timeout with many subscriptions | High | Reliability / Scalability |
| 11 | Webhook ignores Supabase errors — silent data loss | High | Data Integrity |
| 12 | No rate limiting on auth endpoint | High | Security |
| 13 | Missing `customer.subscription.updated` handler | High | Data Integrity |
| 14 | No `.env.example` — env vars undocumented | Low | Deployment |
| 15 | Missing `vercel.json` — cron never runs | Low | Deployment |
| 16 | Missing TypeScript devDependencies | Low | Deployment |
| 17 | Hardcoded email sender address | Low | Config |
| 18 | HTML injection in email template | Low | Security |
| 19 | Live Stripe key in local env | Low | Security / Config |

---

## Deployment Checklist

Before deploying, verify:
- [ ] Fix `lib/supabase.ts`: split admin client into separate `server-only` module
- [ ] Fix `app/dashboard/page.tsx`: use `@supabase/ssr` `createServerClient` with cookies so `getUser()` works
- [ ] Fix `app/dashboard/page.tsx`: add null check for `subscription` before accessing properties
- [ ] Fix `app/api/webhook/route.ts`: change `.insert()` to `.upsert()` with conflict on `stripe_subscription_id`
- [ ] Fix `app/api/webhook/route.ts`: use Stripe's actual `current_period_end` instead of hardcoded 30 days
- [ ] Fix `app/api/webhook/route.ts`: check Supabase error responses and return 500 on failure
- [ ] Fix `app/api/webhook/route.ts`: add handler for `customer.subscription.updated`
- [ ] Fix `app/api/cron/route.ts`: add `CRON_SECRET` authorization check
- [ ] Fix `app/api/cron/route.ts`: wrap loop body in try/catch for resilience
- [ ] Fix `app/api/auth/route.ts`: add input validation and try/catch on `req.json()`
- [ ] Fix `app/api/auth/route.ts`: stop returning session tokens in response body — use cookie-based auth
- [ ] Add `vercel.json` with cron schedule configuration
- [ ] Add `.env.example` documenting all required environment variables
- [ ] Add TypeScript devDependencies to `package.json`
- [ ] Ensure `.env.local` is in `.gitignore` and switch to `sk_test_` key for development

---

**Verdict:** This app has several showstoppers that will break core functionality for every user. The dashboard will never load correctly (server-side auth is broken and null subscription crashes the page), webhook retries will cause data corruption, the cron job is publicly accessible, and the service role key may leak to the client. These need to be fixed before any deployment.

**Suggested next action:** Fix the Supabase client setup first — split the admin client into a `server-only` module and create a proper SSR-compatible server client for the dashboard. This unblocks both the auth flow and the security issue in a single change, and lets you verify the dashboard actually works before tackling the other fixes.

---

> Want me to fix any of these? Or should I run a deeper audit on a specific area?

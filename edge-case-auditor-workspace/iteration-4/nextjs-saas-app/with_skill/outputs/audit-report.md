# Edge Case Audit Report — SaaS Dashboard (Next.js + Supabase + Stripe)

## What's solid

- **Stripe webhook signature verification is in place.** The `constructEvent` call correctly reads the raw body and validates the signature before processing any events — this is the #1 thing people skip.
- **Admin vs anon Supabase clients are separated.** Sensitive operations (webhook DB writes, cron syncs) use `supabaseAdmin` with the service role key, while the dashboard uses the anon client. Correct boundary.
- **Webhook handles both subscription creation and cancellation.** The two most critical lifecycle events (`checkout.session.completed`, `customer.subscription.deleted`) are covered, and the DB writes target the right columns.
- **Cron job cross-references Stripe as source of truth for subscription status.** Rather than trusting local DB state alone, it calls `stripe.subscriptions.retrieve` to verify — good instinct.

---

## Critical

### C1. Dashboard uses anon Supabase client in a Server Component — will fail in production

`app/dashboard/page.tsx` calls `supabase.auth.getUser()` using the anon client from `lib/supabase.ts`. In a Next.js Server Component, there are no browser cookies available. The anon client has no session context, so `getUser()` will **always** return `null` — every user sees "Please log in" and the dashboard is unusable.

**Fix:** Use `@supabase/ssr`'s `createServerClient` with the `cookies()` adapter from `next/headers`:

```ts
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

function createSupabaseServer() {
  const cookieStore = cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookies: { get: (name) => cookieStore.get(name)?.value } }
  );
}
```

### C2. Webhook uses `.insert()` — duplicate rows on Stripe retries

Stripe retries webhook deliveries (up to ~15 times over 72 hours). Each retry of `checkout.session.completed` inserts a **new** subscription row for the same user. This corrupts billing state — the dashboard's `.single()` call will then throw because multiple rows match.

**Fix:** Change `.insert()` to `.upsert()` with a conflict target on `stripe_subscription_id`:

```ts
await supabaseAdmin.from('subscriptions').upsert({
  ...payload
}, { onConflict: 'stripe_subscription_id' });
```

Add a unique constraint on `stripe_subscription_id` in Supabase if one doesn't exist.

### C3. Cron route has no authentication — anyone can trigger it

`app/api/cron/route.ts` is a public `GET` endpoint. Any HTTP client can hit `/api/cron` and trigger subscription checks, Stripe API calls, and email sends. This is both a denial-of-wallet risk (Stripe + Resend API usage) and a data integrity risk.

**Fix:** Validate a `CRON_SECRET` from the `Authorization` header (this is what Vercel Cron expects):

```ts
export async function GET(req: Request) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  // ...existing logic
}
```

### C4. Auth endpoint returns session tokens in the response body — XSS-exploitable

`app/api/auth/route.ts` returns `data.session` directly in the JSON response. The session object contains the access token and refresh token. If any XSS vulnerability exists anywhere in the app, an attacker can exfiltrate these tokens and impersonate users.

**Fix:** Set tokens in `httpOnly` cookies instead of returning them in the response body. Use `@supabase/ssr`'s cookie-based auth flow, which handles this correctly. The response should return only user profile data, never tokens.

---

## High

### H1. Dashboard does not null-check `.single()` result — runtime crash for new users

If a user has no subscription row (e.g., free trial, just signed up), `supabase.from('subscriptions').select('*').eq('user_id', user.id).single()` returns `{ data: null, error: ... }`. The template then accesses `subscription.plan`, which throws `TypeError: Cannot read properties of null`. The page crashes with a 500 error.

**Fix:** Check for null and render a "no active subscription" state:

```tsx
if (!subscription) {
  return <div>No active subscription. <a href="/pricing">Choose a plan</a></div>;
}
```

### H2. `current_period_end` is hardcoded to now+30 days instead of using Stripe's value

In the webhook handler, `current_period_end` is set to `Date.now() + 30 * 24 * 60 * 60 * 1000`. This ignores the actual billing period from Stripe — annual plans, trials, prorations, and mid-cycle changes will all show the wrong renewal date. The cron job will then flag subscriptions as "expiring" at the wrong time.

**Fix:** Retrieve the subscription object from Stripe to get the real `current_period_end`:

```ts
const stripeSub = await stripe.subscriptions.retrieve(session.subscription as string);
// use: new Date(stripeSub.current_period_end * 1000).toISOString()
```

### H3. Missing `customer.subscription.updated` and `invoice.payment_failed` webhook events

The webhook only handles session completion and subscription deletion. It misses:
- **`customer.subscription.updated`**: Plan changes, renewal date changes, and status transitions (e.g., `past_due`) are silently dropped. Local DB drifts from Stripe.
- **`invoice.payment_failed`**: Failed payment attempts aren't tracked — users with declined cards remain "active" in your DB indefinitely.

**Fix:** Add handlers for both events. At minimum, sync `status`, `plan`, and `current_period_end` from the subscription object on every `customer.subscription.updated` event.

### H4. Missing `vercel.json` cron schedule — cron job will never run on Vercel

Vercel Cron requires a `vercel.json` configuration to schedule the endpoint. Without it, `/api/cron` exists as a route but is never automatically invoked. Subscriptions will never be checked for expiration.

**Fix:** Add `vercel.json`:

```json
{
  "crons": [{
    "path": "/api/cron",
    "schedule": "0 6 * * *"
  }]
}
```

### H5. `supabaseAdmin` client is importable from a client-side module — service role key leakable

`lib/supabase.ts` exports both `supabase` (anon) and `supabaseAdmin` (service role) from the same file. If any client component imports from `@/lib/supabase`, the bundler may include `SUPABASE_SERVICE_ROLE_KEY` in the client bundle. The key isn't prefixed with `NEXT_PUBLIC_`, so Next.js won't expose it by default, but a careless import of the wrong export could bypass this protection.

**Fix:** Move `supabaseAdmin` to a separate file (`lib/supabase-admin.ts`) and add `import 'server-only'` at the top to guarantee a build error if it's ever imported client-side.

### H6. User-controlled name interpolated directly into HTML email — stored XSS / email injection

In the cron route, `sub.users.name` is interpolated directly into the HTML email body: `` `<p>Hi ${sub.users.name}...` ``. If a user sets their name to contain HTML/script tags, the email renders attacker-controlled markup. Some email clients execute limited HTML, and this can be used for phishing or credential harvesting within the email.

**Fix:** Escape HTML entities before interpolation, or use a templating library (e.g., React Email with Resend) that escapes by default.

---

## Worth noting

### W1. Supabase `{ data, error }` pattern — errors are silently ignored throughout

Every Supabase call in the cron route and webhook destructures `{ data }` but never checks `error`. A failed DB write (e.g., RLS policy rejection, constraint violation, network timeout) is silently swallowed. The webhook returns 200 to Stripe even if the DB write failed, so Stripe won't retry. Consider at minimum logging errors and returning 500 from the webhook on DB failures so Stripe retries.

### W2. Cron iterates sequentially with unbounded Stripe API calls

The cron route loops over all expiring subscriptions and calls `stripe.subscriptions.retrieve` serially for each one. At scale, this can exceed Vercel's function timeout (default 10s on Hobby, 60s on Pro) and Stripe rate limits (25 req/s in test, 100 req/s in live). Consider batching or adding a `LIMIT` to the Supabase query.

### W3. No rate limiting on the auth endpoint

`/api/auth` accepts unlimited login attempts with no rate limiting, CAPTCHA, or lockout. This enables credential stuffing. Consider adding rate limiting via Vercel Edge Middleware or an upstream WAF.

---

## Risk Summary

| ID | Severity | Category | What breaks |
|----|----------|----------|-------------|
| C1 | Critical | Auth | Dashboard shows "Please log in" for every user — SSR has no session context |
| C2 | Critical | Billing | Stripe webhook retries create duplicate subscription rows |
| C3 | Critical | Security | Cron endpoint is publicly callable — denial-of-wallet and data integrity risk |
| C4 | Critical | Security | Session tokens in response body exploitable via XSS |
| H1 | High | Runtime | Dashboard crashes with 500 for users without a subscription |
| H2 | High | Billing | Renewal dates are wrong for non-monthly plans |
| H3 | High | Billing | Plan changes and failed payments silently ignored |
| H4 | High | Deploy | Cron job never executes on Vercel without `vercel.json` |
| H5 | High | Security | Service role key could leak to client bundle |
| H6 | High | Security | User-supplied name rendered as raw HTML in emails |

---

## Deployment checklist (Critical + High)

- [ ] **C1** — Replace anon client in `dashboard/page.tsx` with `@supabase/ssr` `createServerClient` using cookies
- [ ] **C2** — Change webhook `.insert()` to `.upsert()` on `stripe_subscription_id`; add unique constraint
- [ ] **C3** — Add `CRON_SECRET` Bearer token check to `/api/cron`
- [ ] **C4** — Stop returning `data.session` in auth response; use `httpOnly` cookie-based auth via `@supabase/ssr`
- [ ] **H1** — Null-check `subscription` before rendering in dashboard
- [ ] **H2** — Fetch `current_period_end` from Stripe subscription object instead of hardcoding +30 days
- [ ] **H3** — Add `customer.subscription.updated` and `invoice.payment_failed` webhook handlers
- [ ] **H4** — Add `vercel.json` with cron schedule configuration
- [ ] **H5** — Move `supabaseAdmin` to a separate file with `import 'server-only'`
- [ ] **H6** — HTML-escape `sub.users.name` in email template

---

## Verdict

**Do not deploy yet.** There are 4 critical issues. C1 makes the dashboard non-functional for all users. C2 will corrupt billing data the first time Stripe retries a webhook. C3 leaves an expensive endpoint wide open. C4 is a real security gap. The high-severity items (H1-H6) each have clear fixes — most are one-line changes. I'd estimate 2-3 hours to address everything on this list, after which this is in solid shape to ship.

## Suggested next action

Start with C1 (SSR auth) since it blocks all dashboard functionality. Then fix C2 (upsert) and C3 (cron auth) together — they're quick. C4 (cookie-based tokens) pairs naturally with C1 since both involve switching to `@supabase/ssr`.

---

I can help you implement the `@supabase/ssr` cookie-based auth setup that fixes both C1 and C4 simultaneously — that's the highest-leverage change since it unblocks the dashboard and closes the token exposure in one pass. Want me to write that out?

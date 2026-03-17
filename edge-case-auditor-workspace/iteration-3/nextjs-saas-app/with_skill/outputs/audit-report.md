## Edge Case Audit — Next.js SaaS App (Stripe + Supabase) — Pre-Deploy

**What I reviewed:** `app/api/webhook/route.ts`, `app/api/auth/route.ts`, `app/api/cron/route.ts`, `app/dashboard/page.tsx`, `lib/supabase.ts`, `package.json`, `.env.local`
**Build health:** Critical Issues

---

### What's solid
> - Stripe webhook signature verification is in place — this is the single most important security step in a billing integration and it's done correctly.
> - The cron job has reasonable logic: it cross-references local subscription state against Stripe's source of truth and sends expiration emails via Resend.
> - The admin client is correctly separated from the anon client in `lib/supabase.ts`, showing awareness of the privilege boundary.
> - The webhook handles both `checkout.session.completed` and `customer.subscription.deleted`, covering the two most critical lifecycle events.

---

### Critical — Will break in production

**Dashboard server component calls `supabase.auth.getUser()` on the anon client — always returns null**
- **Where:** `app/dashboard/page.tsx:4` — `Dashboard()`
- **What happens:** The `supabase` client from `lib/supabase.ts` is created with `createClient()` from `@supabase/supabase-js`. In a Next.js server component, this client has no access to the user's cookies or session. `getUser()` will always return `null`, so every user sees "Please log in" — the dashboard never renders.
- **Fix:** Use `@supabase/ssr` (already in `package.json`) with `createServerClient` and pass the cookie store. In Next.js App Router:
```ts
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

const cookieStore = cookies();
const supabase = createServerClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  { cookies: { get: (name) => cookieStore.get(name)?.value } }
);
```

**Dashboard accesses `subscription.plan` without null check — runtime crash for new users**
- **Where:** `app/dashboard/page.tsx:15-17` — template rendering
- **What happens:** `.single()` returns `null` when no subscription exists (new user, cancelled user, free-tier user). Accessing `subscription.plan` on `null` throws `TypeError: Cannot read properties of null`. This is an unhandled server component crash — the user gets a 500 error.
- **Fix:** Null-check the subscription before rendering:
```tsx
const { data: subscription } = await supabase
  .from('subscriptions').select('*').eq('user_id', user.id).single();

if (!subscription) {
  return <div>No active subscription. <a href="/pricing">Choose a plan</a></div>;
}
```

**Cron endpoint has no authentication — anyone can trigger it**
- **Where:** `app/api/cron/route.ts:10` — `GET()`
- **What happens:** The cron route is a public `GET` endpoint. Anyone who discovers `/api/cron` can trigger subscription checks, Stripe API calls, and email sends at will. This is both a denial-of-wallet risk (Stripe API calls cost money at scale) and an email spam vector.
- **Fix:** Verify the `CRON_SECRET` header that Vercel sends with cron invocations:
```ts
export async function GET(req: Request) {
  const authHeader = req.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  // ... rest of handler
}
```

**Auth route returns session token in response body — exposed to XSS**
- **Where:** `app/api/auth/route.ts:14` — `POST()`
- **What happens:** The session object (containing the access token and refresh token) is returned as JSON in the response body. Any XSS vulnerability anywhere in the app can exfiltrate these tokens. This is the difference between "XSS can read page content" and "XSS can steal the user's full session."
- **Fix:** Set the session tokens as `HttpOnly`, `Secure`, `SameSite=Lax` cookies instead of returning them in the body. Better yet, use Supabase's built-in PKCE auth flow with `@supabase/ssr` which handles this automatically.

**Admin client (service role key) importable from client components**
- **Where:** `lib/supabase.ts:7` — `supabaseAdmin`
- **What happens:** The `supabaseAdmin` client is exported from a module with no `'server-only'` guard. If any client component (or any code that gets bundled for the browser) imports from `@/lib/supabase`, the `SUPABASE_SERVICE_ROLE_KEY` will be embedded in the client JavaScript bundle. The service role key bypasses all Row-Level Security — this is full database access.
- **Fix:** Either add `import 'server-only'` at the top of `lib/supabase.ts`, or better, split into two files:
```ts
// lib/supabase-admin.ts
import 'server-only';
import { createClient } from '@supabase/supabase-js';

export const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);
```

---

### High — Will bite you under realistic conditions

**Webhook insert with no idempotency — duplicate subscriptions on retries**
- **Where:** `app/api/webhook/route.ts:18` — `checkout.session.completed` handler
- **What happens:** Stripe retries webhook deliveries when it gets timeouts or 5xx responses. The handler uses `.insert()`, so a retried `checkout.session.completed` event creates a duplicate row in `subscriptions`. This leads to duplicate billing records and unpredictable `.single()` query failures elsewhere.
- **Fix:** Use `.upsert()` with a unique constraint on `stripe_subscription_id`:
```ts
await supabaseAdmin.from('subscriptions').upsert({
  stripe_subscription_id: session.subscription,
  user_id: session.metadata?.userId,
  // ...
}, { onConflict: 'stripe_subscription_id' });
```

**Subscription period end date is hardcoded to 30 days instead of using Stripe's value**
- **Where:** `app/api/webhook/route.ts:25` — `checkout.session.completed` handler
- **What happens:** `current_period_end` is set to `Date.now() + 30 days` regardless of the actual plan interval. Annual plans, trials, prorated subscriptions — all get a 30-day expiry. The cron job then marks them as expired prematurely, triggering false "your subscription expired" emails.
- **Fix:** Retrieve the subscription from Stripe to get the real period end:
```ts
const stripeSub = await stripe.subscriptions.retrieve(session.subscription as string);
current_period_end: new Date(stripeSub.current_period_end * 1000).toISOString()
```

**Missing webhook event types: `customer.subscription.updated` and `invoice.payment_failed`**
- **Where:** `app/api/webhook/route.ts`
- **What happens:** Plan changes, payment method updates, and failed payments are not captured. A user who upgrades/downgrades will have stale plan data locally. A user whose card fails will remain "active" until the cron job catches it up to 24 hours later (or longer on weekends if cron fails).
- **Fix:** Add handlers for at minimum `customer.subscription.updated` (sync plan/status/period changes) and `invoice.payment_failed` (mark status as `past_due`, notify user).

**Checkout session metadata assumed present — null reference on missing fields**
- **Where:** `app/api/webhook/route.ts:20` — `session.metadata.userId`
- **What happens:** If the checkout session was created without `metadata.userId` or `metadata.plan` (developer mistake, or a different checkout flow), `session.metadata.userId` is `undefined`. This inserts a subscription row with `user_id: null`, orphaning it from any user.
- **Fix:** Validate metadata before processing:
```ts
if (!session.metadata?.userId || !session.metadata?.plan) {
  console.error('Checkout session missing required metadata', session.id);
  return NextResponse.json({ error: 'Missing metadata' }, { status: 400 });
}
```

**Cron job makes unbounded sequential Stripe API calls — timeout risk**
- **Where:** `app/api/cron/route.ts:20-42` — `for` loop
- **What happens:** The cron iterates over all expiring subscriptions and makes a sequential `stripe.subscriptions.retrieve()` for each one. Vercel serverless functions have a 10-second timeout on the Hobby plan (60s on Pro). With 50+ expiring subscriptions, the function will time out, leaving some subscriptions unprocessed with no record of which ones were handled.
- **Fix:** Process in batches with `Promise.all()` (batches of 10) and add a limit to the query. Also consider paginating and tracking progress.

**No Supabase error checking on any database operation**
- **Where:** `app/api/webhook/route.ts`, `app/api/cron/route.ts`, `app/dashboard/page.tsx`
- **What happens:** Every Supabase call returns `{ data, error }` but `error` is never checked. Failed inserts, updates, and selects are silently ignored. The webhook returns `200` to Stripe even if the database write failed, so Stripe won't retry — the subscription data is lost.
- **Fix:** Check `error` on every Supabase call and return appropriate status codes. For webhooks, return `500` on DB failure so Stripe retries.

---

### Worth noting — Low risk but worth a look

**No `.env.example` and `.env.local` may not be gitignored**
- **Where:** `.env.local`
- **What happens:** Without `.env.example`, other developers (or your future self after a fresh clone) won't know which env vars are required. If `.gitignore` doesn't include `.env.local`, live API keys could be committed to the repo.
- **Fix:** Create `.env.example` with placeholder values. Verify `.gitignore` includes `.env*`.

**Missing `vercel.json` for cron schedule**
- **Where:** Project root
- **What happens:** The cron route exists but without `vercel.json` defining the cron schedule, Vercel won't invoke it automatically. You'd need to set it up manually or it simply won't run.
- **Fix:** Add `vercel.json`:
```json
{
  "crons": [{ "path": "/api/cron", "schedule": "0 0 * * *" }]
}
```

**No input validation on auth route**
- **Where:** `app/api/auth/route.ts:5`
- **What happens:** The POST body is destructured without validation. Malformed JSON or missing fields will produce unhelpful Supabase error messages. Not a security issue (Supabase validates on its end) but poor UX.
- **Fix:** Validate that `email` and `password` are non-empty strings before calling Supabase.

**XSS via user name in email template**
- **Where:** `app/api/cron/route.ts:40` — `sub.users.name`
- **What happens:** The user's name is interpolated directly into an HTML email template. If a user's name contains `<script>` or similar, the email HTML will include it unescaped. Most email clients strip scripts, but some render injected HTML elements.
- **Fix:** Escape user-supplied values or use a templating library that escapes by default.

---

### Risk Summary
| # | Issue | Severity | Category |
|---|-------|----------|----------|
| 1 | Dashboard `getUser()` always returns null in server component | Critical | Auth / SSR |
| 2 | Null reference crash on missing subscription data | Critical | Data Fetching |
| 3 | Cron endpoint has no authentication | Critical | Security |
| 4 | Session tokens returned in response body | Critical | Security |
| 5 | Admin client / service role key exposed to client bundle | Critical | Security |
| 6 | Webhook insert has no idempotency — duplicates on retry | High | Billing |
| 7 | Subscription period hardcoded to 30 days | High | Billing |
| 8 | Missing webhook events (updated, payment_failed) | High | Billing |
| 9 | Checkout session metadata not validated | High | Billing |
| 10 | Cron sequential Stripe calls — timeout risk | High | Reliability |
| 11 | No error checking on Supabase operations | High | Reliability |
| 12 | No `.env.example`, `.env.local` gitignore unverified | Worth noting | Config |
| 13 | Missing `vercel.json` for cron schedule | Worth noting | Deployment |
| 14 | No input validation on auth route | Worth noting | Validation |
| 15 | XSS in email template via user name | Worth noting | Security |

---

### Deployment Checklist
- [ ] Fix dashboard auth: use `@supabase/ssr` `createServerClient` with cookie access
- [ ] Add null checks for `subscription` and `usage` query results in dashboard
- [ ] Add `CRON_SECRET` verification to the cron endpoint
- [ ] Move session management to HttpOnly cookies (or use Supabase PKCE flow)
- [ ] Add `import 'server-only'` to `lib/supabase.ts` or split admin client into separate file
- [ ] Change webhook `.insert()` to `.upsert()` on `stripe_subscription_id`
- [ ] Retrieve real `current_period_end` from Stripe instead of hardcoding 30 days
- [ ] Add `customer.subscription.updated` and `invoice.payment_failed` webhook handlers
- [ ] Validate `session.metadata` fields before processing checkout webhook
- [ ] Add error checking on all Supabase operations; return 500 in webhook on DB failure
- [ ] Add batch processing / concurrency limit to cron job
- [ ] Add `vercel.json` with cron schedule

---

**Verdict:** This build has the right architectural bones — Stripe webhook verification, admin/anon client separation, cron-based sync — but has five critical issues that will prevent it from functioning correctly in production. The dashboard won't render for any user, session tokens are exposed, and the admin key can leak to the client bundle.

**Suggested next action:** Start with the dashboard auth fix (issue #1) since it blocks all user-facing functionality. Use `@supabase/ssr`'s `createServerClient` with the cookie store, then add the `'server-only'` import to the admin client module. Those two changes fix the two most fundamental problems.

---

Want me to write the `@supabase/ssr` server client setup and refactor the dashboard component? That would resolve issues #1, #2, and #5 in one pass.

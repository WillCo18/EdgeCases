# Pre-Deployment Audit Report: SaaS Dashboard (Next.js + Supabase + Stripe)

**Date:** 2026-03-16
**Scope:** Full codebase review of 7 project files before Vercel deployment

---

## CRITICAL Issues (Must Fix Before Shipping)

### 1. Cron Endpoint Has No Authentication (`app/api/cron/route.ts`)

The `/api/cron` GET endpoint is completely open to the public internet. Anyone can trigger subscription checks, Stripe API calls, and email sends by simply visiting the URL.

**Fix:** Verify the `Authorization` header contains the `CRON_SECRET` that Vercel injects for cron jobs:

```ts
export async function GET(req: Request) {
  const authHeader = req.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  // ... rest of handler
}
```

You also need a `vercel.json` with the cron schedule defined -- this is missing from the project entirely.

### 2. Webhook Handler Does Not Check Supabase Errors (`app/api/webhook/route.ts`)

The `supabaseAdmin.from('subscriptions').insert(...)` and `.update(...)` calls do not check for errors. If the database write fails silently, the user pays Stripe but never gets their subscription activated. This is a money-takes-but-no-service bug.

**Fix:** Check the `error` return from every Supabase call and return a non-200 status so Stripe retries the webhook:

```ts
const { error } = await supabaseAdmin.from('subscriptions').insert({...});
if (error) {
  console.error('Failed to insert subscription:', error);
  return NextResponse.json({ error: 'DB write failed' }, { status: 500 });
}
```

### 3. Webhook Hardcodes `current_period_end` Instead of Reading It from Stripe (`app/api/webhook/route.ts`, line 27)

```ts
current_period_end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
```

This blindly assumes every plan is exactly 30 days. Yearly plans, trial periods, and custom billing cycles will all have wrong expiry dates. The actual period end is available on the Stripe subscription object.

**Fix:** Retrieve the subscription from Stripe and use its `current_period_end`:

```ts
const stripeSub = await stripe.subscriptions.retrieve(session.subscription as string);
current_period_end: new Date(stripeSub.current_period_end * 1000).toISOString()
```

### 4. Webhook Does Not Handle `customer.subscription.updated` Events

The webhook only handles `checkout.session.completed` and `customer.subscription.deleted`. It does not handle `customer.subscription.updated`, which fires on renewals, plan changes, payment failures, and trial endings. Without this, your local subscription data will drift out of sync with Stripe.

### 5. Auth Endpoint Returns Raw Session Token in JSON Body (`app/api/auth/route.ts`)

The `/api/auth` POST endpoint returns the full session object (including the access token and refresh token) directly in the JSON response body. This means:
- Tokens are accessible to any JavaScript on the page (XSS risk).
- There is no HttpOnly cookie being set, so the session is not protected by the browser's cookie security model.

**Fix:** Use `@supabase/ssr` (which is already in your `package.json`) to create a server-side Supabase client that manages sessions via HttpOnly cookies. The current approach of using `supabase.auth.signInWithPassword` from a raw `createClient` on the server does not set cookies for the browser.

### 6. Dashboard Will Crash on Null Subscription (`app/dashboard/page.tsx`, lines 28-30)

If a user has no subscription (new user, expired, deleted), the `.single()` query returns `null` for `data`. The template then accesses `subscription.plan`, `subscription.status`, and `subscription.current_period_end` -- all of which will throw a runtime error and crash the page.

**Fix:** Add a null check:

```tsx
if (!subscription) {
  return <div>No active subscription. <a href="/pricing">Choose a plan</a></div>;
}
```

Similarly, `usage` could be `null` if the query fails, and `.map()` on `null` will crash.

---

## HIGH Issues (Should Fix Before Shipping)

### 7. Dashboard Uses Anon Key Server-Side Without Cookie-Based Auth (`app/dashboard/page.tsx`)

The dashboard is a React Server Component that calls `supabase.auth.getUser()` using the anon-key client from `lib/supabase.ts`. This client has no access to the user's session cookies -- it was created with just the URL and anon key, with no cookie forwarding. As a result, `getUser()` will always return `null`, and the dashboard will always show "Please log in" regardless of auth state.

**Fix:** Use `createServerClient` from `@supabase/ssr` with cookie access from `next/headers` to create a request-scoped Supabase client that can read the auth session.

### 8. Supabase Admin Client Is Importable Anywhere (`lib/supabase.ts`)

Both `supabase` (anon) and `supabaseAdmin` (service role) are exported from the same file. The service role key bypasses all Row Level Security. If any client-side code accidentally imports `supabaseAdmin`, the service role key will be bundled into client JavaScript and exposed to every user.

**Fix:** Move `supabaseAdmin` to a separate file (e.g., `lib/supabase-admin.ts`) and add a check:

```ts
if (typeof window !== 'undefined') {
  throw new Error('supabaseAdmin must not be used in client-side code');
}
```

Or use Next.js `server-only` package:

```ts
import 'server-only';
```

### 9. Cron Job Crashes If `expiring` Is Null (`app/api/cron/route.ts`, line 21)

The `for (const sub of expiring)` loop does not guard against `expiring` being `null` (which Supabase returns when the query fails). This will crash the cron job with `TypeError: expiring is not iterable`.

**Fix:** Default to an empty array: `for (const sub of expiring ?? [])`

### 10. Cron Job Makes Sequential Stripe API Calls With No Rate Limiting

For each expiring subscription, the cron job calls `stripe.subscriptions.retrieve()` one at a time in a `for` loop. With many expiring subscriptions, this could:
- Exceed Vercel's serverless function timeout (default 10s on Hobby, 60s on Pro).
- Hit Stripe API rate limits (100 requests/sec in live mode).

**Fix:** Process in batches with `Promise.all` and add a batch size limit. Also consider increasing the Vercel function timeout via `maxDuration` in route config.

### 11. Email Template Has an HTML Injection / XSS Vector (`app/api/cron/route.ts`, line 44)

```ts
html: `<p>Hi ${sub.users.name}, your subscription has expired...</p>`
```

The user's name is interpolated directly into HTML with no escaping. If a user's name contains `<script>` tags or other HTML, it will be rendered in the email client (some email clients execute JavaScript or at minimum render injected HTML).

**Fix:** Escape the name or use Resend's React email templates.

---

## MEDIUM Issues

### 12. No `vercel.json` With Cron Configuration

Vercel cron jobs require a `vercel.json` that declares the cron schedule. Without it, the cron endpoint will never be called automatically.

```json
{
  "crons": [{
    "path": "/api/cron",
    "schedule": "0 0 * * *"
  }]
}
```

### 13. No Input Validation on Auth Endpoint (`app/api/auth/route.ts`)

The endpoint calls `await req.json()` and destructures `email` and `password` without any validation. Malformed JSON will throw an unhandled error (500). Missing fields will pass `undefined` to Supabase.

### 14. Missing `typescript` and `@types/react` in `package.json`

The project uses TypeScript (`.ts` and `.tsx` files) but `typescript`, `@types/react`, and `@types/node` are not listed as dependencies or devDependencies. The build may fail on Vercel.

### 15. No `.env.example` or Environment Variable Documentation

The `.env.local` file exists but there is no `.env.example` for other developers or for configuring Vercel's environment variables. Make sure `.env.local` is in `.gitignore` and is NOT committed to version control (it contains live Stripe secret keys).

### 16. Using `sk_live_` Stripe Key in `.env.local`

The Stripe secret key starts with `sk_live_`, indicating this is a **production** key being used in local development. Use `sk_test_` keys for development and only set the live key in Vercel's environment variables.

### 17. No Error Handling in Cron Email Sends

If `resend.emails.send()` fails for one user, the error is unhandled and will crash the entire cron job, skipping all remaining subscriptions.

### 18. `cron` npm Package Is Unused

`package.json` lists `"cron": "^3.1.0"` as a dependency, but the cron functionality is handled by Vercel Cron (HTTP-based), not the `cron` npm package. This is dead weight.

---

## Summary Table

| # | Severity | File | Issue |
|---|----------|------|-------|
| 1 | CRITICAL | `api/cron/route.ts` | Cron endpoint has no auth -- publicly callable |
| 2 | CRITICAL | `api/webhook/route.ts` | DB errors silently ignored -- payment without activation |
| 3 | CRITICAL | `api/webhook/route.ts` | Hardcoded 30-day period instead of reading from Stripe |
| 4 | CRITICAL | `api/webhook/route.ts` | Missing `subscription.updated` event handler |
| 5 | CRITICAL | `api/auth/route.ts` | Session tokens returned in JSON body, no HttpOnly cookies |
| 6 | CRITICAL | `dashboard/page.tsx` | Null subscription crashes the page |
| 7 | HIGH | `dashboard/page.tsx` | Server component auth will never work without cookie-based client |
| 8 | HIGH | `lib/supabase.ts` | Admin client can leak service role key to client bundle |
| 9 | HIGH | `api/cron/route.ts` | Null `expiring` crashes the loop |
| 10 | HIGH | `api/cron/route.ts` | Sequential Stripe calls risk timeout and rate limits |
| 11 | HIGH | `api/cron/route.ts` | HTML injection in email template |
| 12 | MEDIUM | (missing) | No `vercel.json` for cron schedule |
| 13 | MEDIUM | `api/auth/route.ts` | No input validation |
| 14 | MEDIUM | `package.json` | Missing TypeScript devDependencies |
| 15 | MEDIUM | `.env.local` | No `.env.example`; ensure not committed |
| 16 | MEDIUM | `.env.local` | Live Stripe key used in local dev |
| 17 | MEDIUM | `api/cron/route.ts` | Unhandled email send errors |
| 18 | MEDIUM | `package.json` | Unused `cron` npm dependency |

---

## Recommendation

**Do not deploy yet.** The critical issues (1-6) can cause real financial and security problems in production -- users paying without getting access, unauthenticated endpoints being abused, and pages crashing. Issues 7-8 mean the dashboard auth flow fundamentally will not work as written. Fix the critical and high issues first, then address the medium issues before going live.

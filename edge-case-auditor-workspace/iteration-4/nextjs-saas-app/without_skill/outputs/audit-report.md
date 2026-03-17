# Pre-Deploy Audit Report: SaaS Dashboard (Next.js + Supabase + Stripe)

## Executive Summary

This audit covers a Next.js SaaS application with Supabase auth/database, Stripe billing, a subscription-check cron job, and a dashboard page. Several **critical security issues**, **runtime crash risks**, and **architectural concerns** were identified that should be resolved before deploying to production on Vercel.

---

## Critical Issues

### 1. Supabase Service Role Key Exposed to the Client Bundle

**File:** `lib/supabase.ts`
**Severity:** CRITICAL

The `supabaseAdmin` client is created in a shared module using `SUPABASE_SERVICE_ROLE_KEY`. Although this env var is not prefixed with `NEXT_PUBLIC_`, the module is imported by `app/dashboard/page.tsx` (a server component) but also potentially importable from any client component. More importantly, the `supabase` (anon) client and `supabaseAdmin` are exported from the same file. If any client-side code ever imports from `@/lib/supabase`, the service role key could be bundled and sent to the browser.

**Recommendation:** Split into two files: `lib/supabase-client.ts` (anon key only) and `lib/supabase-admin.ts` (service role key, server-only). Add `import 'server-only'` at the top of the admin module to guarantee a build error if it is ever imported client-side.

---

### 2. Cron Endpoint Has No Authentication

**File:** `app/api/cron/route.ts`
**Severity:** CRITICAL

The `GET` handler performs privileged operations (updating subscription statuses, sending emails) but does not verify that the caller is authorized. Anyone who discovers the URL can trigger it. On Vercel, cron jobs send an `Authorization` header with a bearer token matching the `CRON_SECRET` environment variable.

**Recommendation:** Check for the `Authorization: Bearer <CRON_SECRET>` header and reject requests that do not match. Example:

```ts
const authHeader = req.headers.get('authorization');
if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}
```

---

### 3. Webhook Handler Does Not Handle All Important Events

**File:** `app/api/webhook/route.ts`
**Severity:** HIGH

Only `checkout.session.completed` and `customer.subscription.deleted` are handled. Missing events include:
- `customer.subscription.updated` -- plan changes, payment failures, trial endings
- `invoice.payment_failed` -- failed renewals
- `invoice.paid` -- successful renewals (to update `current_period_end`)

Without these, subscription state in the database will drift from Stripe's truth. The `current_period_end` is currently hardcoded to "now + 30 days" instead of reading it from the Stripe session/subscription object, which will be wrong for non-monthly plans.

**Recommendation:** Handle at least `customer.subscription.updated` and `invoice.payment_failed`. Read `current_period_end` from the actual Stripe subscription object rather than hardcoding 30 days.

---

### 4. Dashboard Crashes on Null Subscription or Usage

**File:** `app/dashboard/page.tsx`
**Severity:** HIGH

After fetching `subscription` and `usage`, the template accesses `subscription.plan`, `subscription.status`, etc. without null checks. If a user has no subscription row (new user, free tier), this will throw a runtime error crashing the page. Similarly, `usage.map(...)` will throw if `usage` is `null`.

**Recommendation:** Add null/undefined guards:

```tsx
if (!subscription) { return <div>No active subscription found.</div>; }
```

And use optional chaining or default to an empty array for usage: `(usage ?? []).map(...)`.

---

### 5. Auth Route Returns Full Session Token in Response Body

**File:** `app/api/auth/route.ts`
**Severity:** HIGH

The endpoint returns `{ user: data.user, session: data.session }` directly in the JSON response. The session object contains the access token and refresh token. Returning tokens in the response body (rather than setting them as HttpOnly cookies) makes them accessible to JavaScript and vulnerable to XSS-based token theft.

**Recommendation:** Use `@supabase/ssr` (already in `package.json`) to set auth tokens as HttpOnly, Secure, SameSite cookies instead of returning them in the response body. Alternatively, use Supabase's built-in PKCE flow on the client.

---

### 6. Dashboard Uses Anon Client for Server-Side Data Fetching

**File:** `app/dashboard/page.tsx`
**Severity:** HIGH

The dashboard is a server component but uses the anon `supabase` client. In a server component context, there is no browser cookie to carry the user's session. `supabase.auth.getUser()` will likely always return `null` because the anon client has no session context on the server.

**Recommendation:** Use `@supabase/ssr` with `createServerClient` to create a cookie-aware Supabase client for server components. This will properly read the user's auth cookies from the request.

---

## Medium Issues

### 7. Cron Job Does Sequential Stripe API Calls Without Rate Limiting or Batching

**File:** `app/api/cron/route.ts`
**Severity:** MEDIUM

The `for...of` loop calls `stripe.subscriptions.retrieve()` once per expiring subscription sequentially. For a large number of subscriptions, this could:
- Time out on Vercel (functions have a 10s default / 60s max timeout)
- Hit Stripe rate limits (25 requests/second on live mode)

**Recommendation:** Process in batches (e.g., `Promise.all` with chunks of 10-20). Add error handling around individual subscription checks so one failure does not abort the entire run. Consider adding a Vercel function `maxDuration` config.

---

### 8. No Input Validation on Auth Route

**File:** `app/api/auth/route.ts`
**Severity:** MEDIUM

The endpoint destructures `email` and `password` from the request body without any validation. Malformed or missing fields will produce unhelpful errors. There is also no rate limiting, making it vulnerable to brute-force attacks.

**Recommendation:** Validate that `email` is a valid email string and `password` is present before calling Supabase. Consider adding rate limiting (e.g., via Vercel Edge Middleware or Upstash rate limiter).

---

### 9. Missing `vercel.json` Cron Configuration

**Severity:** MEDIUM

For the cron endpoint to actually run on a schedule on Vercel, a `vercel.json` file with a `crons` configuration is required. Without it, the cron route exists but will never be called automatically.

**Recommendation:** Add a `vercel.json`:

```json
{
  "crons": [
    {
      "path": "/api/cron",
      "schedule": "0 3 * * *"
    }
  ]
}
```

---

### 10. No Error Handling in Webhook for Database Operations

**File:** `app/api/webhook/route.ts`
**Severity:** MEDIUM

The `supabaseAdmin.from(...).insert(...)` and `.update(...)` calls do not check for errors. If the database insert fails (e.g., duplicate key, schema mismatch), the webhook returns `200 { received: true }`, and Stripe will not retry. The subscription record is silently lost.

**Recommendation:** Check the `error` property from Supabase responses. Return a 500 status on failure so Stripe will retry the webhook.

---

### 11. Webhook Does Not Handle Idempotency

**File:** `app/api/webhook/route.ts`
**Severity:** MEDIUM

Stripe can deliver the same event multiple times. The `insert` on `checkout.session.completed` will fail or create duplicates if the same event is processed twice.

**Recommendation:** Use `upsert` keyed on `stripe_subscription_id` or track processed event IDs in a separate table.

---

## Low Issues

### 12. `cron` Package in Dependencies But Not Used

**File:** `package.json`
**Severity:** LOW

The `cron` package (`^3.1.0`) is listed as a dependency but no code imports it. On Vercel, scheduling is handled via `vercel.json` cron config, not a Node cron library.

**Recommendation:** Remove `cron` from dependencies to reduce bundle size and attack surface.

---

### 13. Hardcoded Sender Email in Cron Job

**File:** `app/api/cron/route.ts`
**Severity:** LOW

The `from` address `noreply@myapp.com` is hardcoded. This should be an environment variable so it can be configured per environment.

---

### 14. No TypeScript Strict Null Checks Visible

**Severity:** LOW

Multiple non-null assertions (`!`) are used throughout the codebase (e.g., `process.env.STRIPE_SECRET_KEY!`, `req.headers.get('stripe-signature')!`). If any of these environment variables are missing at runtime, the app will throw an unhelpful error.

**Recommendation:** Add runtime checks for required environment variables at startup, or use a validation library like `zod` to parse `process.env`.

---

### 15. No Middleware for Route Protection

**Severity:** LOW

There is no `middleware.ts` to protect the `/dashboard` route or other authenticated pages. Without middleware, unauthenticated users can hit server components and API routes, relying solely on in-component checks.

**Recommendation:** Add a Next.js middleware that checks for a valid Supabase session cookie and redirects unauthenticated users to a login page.

---

## Summary Table

| # | Issue | Severity | File(s) |
|---|-------|----------|---------|
| 1 | Service role key exposed risk | CRITICAL | `lib/supabase.ts` |
| 2 | Cron endpoint unauthenticated | CRITICAL | `app/api/cron/route.ts` |
| 3 | Missing webhook event handlers | HIGH | `app/api/webhook/route.ts` |
| 4 | Dashboard null reference crashes | HIGH | `app/dashboard/page.tsx` |
| 5 | Session tokens in response body | HIGH | `app/api/auth/route.ts` |
| 6 | Anon client in server component | HIGH | `app/dashboard/page.tsx` |
| 7 | Sequential Stripe calls in cron | MEDIUM | `app/api/cron/route.ts` |
| 8 | No input validation on auth | MEDIUM | `app/api/auth/route.ts` |
| 9 | Missing vercel.json cron config | MEDIUM | - |
| 10 | No DB error handling in webhook | MEDIUM | `app/api/webhook/route.ts` |
| 11 | Webhook idempotency missing | MEDIUM | `app/api/webhook/route.ts` |
| 12 | Unused `cron` dependency | LOW | `package.json` |
| 13 | Hardcoded sender email | LOW | `app/api/cron/route.ts` |
| 14 | Non-null assertions everywhere | LOW | Multiple |
| 15 | No auth middleware | LOW | - |

## Verdict

**Do not deploy yet.** The two critical issues (service role key exposure risk and unauthenticated cron endpoint) must be fixed first. The high-severity items (dashboard crashes, missing webhook events, auth token handling, server-side auth) should also be addressed before going live with real users and payments. The medium and low items are strongly recommended but could be addressed in a fast follow-up.

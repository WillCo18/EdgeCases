# Pre-Deployment Audit Report: SaaS Dashboard (Next.js + Supabase + Stripe)

**Date:** 2026-03-16
**Project:** saas-dashboard v0.1.0
**Stack:** Next.js 14.1.0, Supabase, Stripe, Resend, Vercel Cron

---

## CRITICAL Issues (Must Fix Before Deploying)

### 1. Cron Endpoint Has No Authentication (`app/api/cron/route.ts`)

The `GET /api/cron` endpoint is completely unprotected. Anyone on the internet can hit this URL and trigger subscription checks, Stripe API calls, and expiration emails to your users.

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

You also need a `vercel.json` with the cron schedule defined -- this is currently missing from the project.

### 2. Webhook Handler Does Not Check Supabase Errors (`app/api/webhook/route.ts`)

The `supabaseAdmin.from('subscriptions').insert(...)` and `.update(...)` calls never check for errors. If the database write fails (e.g., duplicate key, network issue), the webhook silently returns `{ received: true }` and Stripe considers the event handled. The subscription record is then permanently out of sync.

**Fix:** Check the `error` return from every Supabase call and return a 500 so Stripe retries the webhook:

```ts
const { error } = await supabaseAdmin.from('subscriptions').insert({...});
if (error) {
  console.error('Failed to insert subscription:', error);
  return NextResponse.json({ error: 'Database error' }, { status: 500 });
}
```

### 3. Webhook Hardcodes `current_period_end` Instead of Reading It from Stripe (`app/api/webhook/route.ts`, line 27)

```ts
current_period_end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
```

This assumes every plan is exactly 30 days. Annual plans, weekly plans, and trial periods will all get the wrong expiration date. The actual period end is available on the Stripe subscription object.

**Fix:** Retrieve the subscription from Stripe and use `current_period_end`:

```ts
const stripeSub = await stripe.subscriptions.retrieve(session.subscription as string);
current_period_end: new Date(stripeSub.current_period_end * 1000).toISOString()
```

### 4. Dashboard Crashes on Null Subscription (`app/dashboard/page.tsx`, lines 28-30)

If a logged-in user has no subscription (new signup, cancelled, etc.), `subscription` will be `null` and accessing `subscription.plan` will throw a runtime error, crashing the page.

**Fix:** Add a null check:

```tsx
if (!subscription) {
  return <div>No active subscription. <a href="/pricing">Choose a plan</a></div>;
}
```

### 5. Auth Endpoint Returns Raw Session Token in JSON Body (`app/api/auth/route.ts`, line 16)

```ts
return NextResponse.json({ user: data.user, session: data.session });
```

The full session object (including `access_token` and `refresh_token`) is sent in a plain JSON response. This means the tokens are stored/handled entirely in client-side JavaScript and are vulnerable to XSS. The standard Supabase + Next.js pattern uses `@supabase/ssr` (which is already in your dependencies but unused) to set tokens in httpOnly cookies.

**Fix:** Switch to `@supabase/ssr`'s `createServerClient` pattern so tokens are managed via secure cookies, not raw JSON responses.

---

## HIGH Severity Issues

### 6. Supabase Anon Client Used in Server Component for Auth (`app/dashboard/page.tsx`, line 4)

```ts
const { data: { user } } = await supabase.auth.getUser();
```

This uses the anon-key client created in `lib/supabase.ts`. In a Next.js Server Component, this client has no access to the user's cookies/session, so `getUser()` will always return `null`. The dashboard will always show "Please log in."

**Fix:** Use `@supabase/ssr`'s `createServerClient` with cookie access from `next/headers` to properly read the user's session on the server.

### 7. No Row-Level Security (RLS) Consideration

The dashboard queries `subscriptions` and `usage_logs` filtered by `user_id` in application code. If RLS is not enabled on these tables in Supabase, the anon key (which is public and embedded in the client bundle) could be used to read any user's data directly via the Supabase REST API.

**Fix:** Enable RLS on `subscriptions` and `usage_logs` tables with policies like:

```sql
CREATE POLICY "Users can only read their own data"
ON subscriptions FOR SELECT
USING (auth.uid() = user_id);
```

### 8. Cron Job Has No Error Handling and Can Crash Mid-Loop (`app/api/cron/route.ts`)

The `for...of` loop iterates over expiring subscriptions and makes Stripe API calls and email sends without any try/catch. If `stripe.subscriptions.retrieve()` throws for one subscription (e.g., deleted in Stripe), the entire cron job aborts and remaining subscriptions are never processed.

**Fix:** Wrap the loop body in try/catch, log errors, and continue processing the remaining subscriptions.

### 9. Cron Job Null Safety (`app/api/cron/route.ts`, line 21)

If the Supabase query returns no rows or returns an error, `expiring` will be `null` and `for (const sub of expiring)` will throw. The `data` property is not destructured with a fallback.

**Fix:**

```ts
const { data: expiring, error } = await supabaseAdmin...;
if (error || !expiring) {
  return NextResponse.json({ error: 'Query failed' }, { status: 500 });
}
```

### 10. Webhook Does Not Handle `customer.subscription.updated` Event

You handle `checkout.session.completed` (new subscription) and `customer.subscription.deleted` (cancellation) but not `customer.subscription.updated`. This means plan upgrades/downgrades, payment failures causing `past_due` status, and Stripe-side period renewals are never synced to your database.

---

## MEDIUM Severity Issues

### 11. Potential XSS in Email Template (`app/api/cron/route.ts`, line 44)

```ts
html: `<p>Hi ${sub.users.name}, your subscription has expired...</p>`
```

The user's name is interpolated directly into HTML without escaping. If a user's name contains `<script>` tags or other HTML, this becomes an HTML injection in the email.

### 12. No Input Validation on Auth Endpoint (`app/api/auth/route.ts`)

The `POST /api/auth` endpoint does not validate that `email` and `password` are present, are strings, or meet any format requirements. Malformed requests will produce unclear errors from Supabase.

### 13. No Rate Limiting on Auth Endpoint

The `/api/auth` endpoint has no rate limiting, making it vulnerable to brute-force password attacks. Consider adding rate limiting via Vercel's middleware or an external service.

### 14. Missing `vercel.json` for Cron Configuration

Vercel cron jobs require a `vercel.json` file with the cron schedule. This file is missing, so the cron job will not run automatically after deployment.

```json
{
  "crons": [{
    "path": "/api/cron",
    "schedule": "0 0 * * *"
  }]
}
```

### 15. `session.metadata` May Be Undefined (`app/api/webhook/route.ts`, lines 22, 24)

If a checkout session is created without metadata (e.g., from the Stripe dashboard or a misconfigured checkout flow), `session.metadata.userId` will throw. Add a null check.

### 16. No TypeScript Strict Mode / Missing `tsconfig.json`

There is no `tsconfig.json` in the project. The liberal use of non-null assertions (`!`) throughout the codebase suggests strict mode is either off or not configured. These assertions mask potential runtime errors.

---

## LOW Severity / Best Practice Issues

### 17. `.env.local` Contains `sk_live_` Key

The Stripe secret key prefix `sk_live_` indicates this is a live/production key. Ensure this file is in `.gitignore`. For development, use `sk_test_` keys instead. Verify this file has not been committed to version control.

### 18. No Logging or Monitoring

None of the API routes have structured logging. When issues occur in production (failed webhooks, cron errors, auth failures), there will be no way to debug them. Consider adding a logging service (e.g., Vercel's built-in logs, Axiom, or similar).

### 19. Missing `react-dom` in Dependencies (`package.json`)

`react-dom` is not listed as a dependency. While Next.js may resolve it transitively, it should be explicitly declared.

### 20. No `next.config.js` Present

There is no Next.js configuration file. Depending on your needs, you may want to configure image domains, redirects, headers (CSP, HSTS), or other settings before production.

### 21. Dashboard Uses `any` Type (`app/dashboard/page.tsx`, line 34)

```tsx
{usage.map((log: any) => (
```

Using `any` defeats TypeScript's purpose. Define a proper type for usage logs.

---

## Summary

| Severity | Count | Action Required |
|----------|-------|-----------------|
| CRITICAL | 5     | Must fix before deployment |
| HIGH     | 5     | Should fix before deployment |
| MEDIUM   | 6     | Fix soon after deployment |
| LOW      | 5     | Address when convenient |

**Recommendation: Do NOT deploy until the 5 critical issues are resolved.** The unprotected cron endpoint, missing error handling in the webhook, broken server-side auth in the dashboard, and raw token exposure are all production-breaking or security-impacting problems. The high-severity items (especially RLS and the missing `customer.subscription.updated` handler) should also be addressed before launch to avoid data leakage and billing sync issues.

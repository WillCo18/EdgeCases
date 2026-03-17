# Pre-Deploy Audit: SaaS Dashboard (Next.js + Supabase + Stripe)

I've gone through your codebase and there are several issues you should address before shipping. I'll break them down by severity.

---

## Critical Issues

### 1. Cron endpoint has no authentication

`app/api/cron/route.ts` is a plain `GET` handler with no authorization check. Anyone who discovers the URL can trigger it, which would cause mass Stripe API calls and potentially send emails to all your users.

**Fix:** Vercel Cron jobs send an `Authorization` header with the value of `CRON_SECRET`. You should verify it:

```ts
export async function GET(req: Request) {
  const authHeader = req.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  // ... rest of handler
}
```

### 2. Webhook handler doesn't handle errors on DB operations

In `app/api/webhook/route.ts`, the `supabaseAdmin.from('subscriptions').insert(...)` and `.update(...)` calls have no error handling. If the DB write fails (e.g., duplicate key, network issue), the webhook returns `200 { received: true }` anyway. Stripe will think the event was processed successfully and won't retry. This means you could silently lose subscription data.

**Fix:** Check for errors on every Supabase call and return a 500 if they fail, so Stripe retries the webhook.

### 3. The Supabase client in `lib/supabase.ts` is not suitable for server components

You're using `createClient` directly from `@supabase/supabase-js` with the anon key. In a Next.js App Router server component (like your dashboard), this client has no access to the user's cookies/session. The `supabase.auth.getUser()` call in `app/dashboard/page.tsx` will almost certainly return `null` every time because there's no auth context.

You have `@supabase/ssr` in your dependencies but you're not using it. You need to use `createServerClient` from `@supabase/ssr` for server components, passing in the cookie store. The current setup means your dashboard is broken -- it will always show "Please log in."

### 4. Potential null reference crashes on the dashboard

In `app/dashboard/page.tsx`, if `subscription` is `null` (no subscription found), the page will crash on `subscription.plan` with a "Cannot read properties of null" error. Same for `usage` -- if the query fails or returns null, `usage.map(...)` will throw. There's no null checking after the early `user` check.

**Fix:** Add null/undefined checks:
```tsx
if (!subscription) {
  return <div>No active subscription found.</div>;
}
```

---

## Security Issues

### 5. Session token returned directly in auth response

`app/api/auth/route.ts` returns the full session object (including access and refresh tokens) in the JSON response body. This is risky because:
- API route responses can be cached/logged by intermediaries
- The client needs to handle these tokens securely

With Supabase + Next.js, you should typically use the SSR auth helpers that set tokens as `httpOnly` cookies rather than passing them in response bodies.

### 6. `.env.local` contains live Stripe key (`sk_live_`)

Your `.env.local` has `STRIPE_SECRET_KEY=sk_live_xxxxx`. If this is truly a live key (not a placeholder), make sure this file is in `.gitignore`. More importantly, you should be using `sk_test_` during development. I don't see a `.gitignore` in the files you shared -- verify it exists and includes `.env.local`.

### 7. Service role key instantiated at module level

In `lib/supabase.ts`, `supabaseAdmin` is created at the top level with the service role key. This client bypasses all Row Level Security. While you need it for admin operations (webhooks, cron), make sure it's never imported on the client side. Since `SUPABASE_SERVICE_ROLE_KEY` is not prefixed with `NEXT_PUBLIC_`, Next.js won't bundle it for the client -- but it's worth double-checking your imports. If any client component accidentally imports from `@/lib/supabase`, it could pull in the admin client reference.

**Recommendation:** Split into two files: `lib/supabase-client.ts` and `lib/supabase-admin.ts` to make accidental imports harder.

---

## Reliability Issues

### 8. Webhook doesn't handle all relevant Stripe events

You handle `checkout.session.completed` and `customer.subscription.deleted`, but you're missing several important events:
- `customer.subscription.updated` -- plan changes, payment method updates
- `invoice.payment_failed` -- failed renewal payments
- `customer.subscription.paused` -- if you enable pause functionality

Missing these means your local subscription state will drift from Stripe's actual state.

### 9. Hardcoded 30-day period in webhook

```ts
current_period_end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
```

This assumes all plans are monthly. If you ever add yearly plans, or Stripe prorates, this will be wrong. You should read the actual period end from the Stripe subscription object:

```ts
const subscription = await stripe.subscriptions.retrieve(session.subscription as string);
current_period_end: new Date(subscription.current_period_end * 1000).toISOString()
```

### 10. Cron job iterates sequentially with no rate limiting

The cron handler loops through all expiring subscriptions one by one, making a Stripe API call for each. If you have hundreds of expiring subscriptions, this could:
- Time out (Vercel functions have a 10s default / 60s max timeout)
- Hit Stripe's rate limits (25 requests/second in live mode)

**Fix:** Process in batches, add error handling per-iteration so one failure doesn't stop the whole job, and consider increasing the function timeout in `vercel.json`.

### 11. No error handling in the cron email sending

If `resend.emails.send()` throws, the entire cron job crashes and subsequent subscriptions won't be processed. Wrap each iteration in a try/catch.

---

## Architecture & Best Practice Issues

### 12. No middleware for route protection

There's no `middleware.ts` file. Your dashboard page does a soft check for the user, but without middleware, there's no redirect to a login page. Users hitting `/dashboard` unauthenticated just see "Please log in" as a bare div with no styling or navigation.

### 13. No TypeScript types for database models

You're using `any` types (e.g., `usage.map((log: any) => ...)`) and relying on implicit types from Supabase. Consider generating types from your Supabase schema using `supabase gen types typescript` for type safety.

### 14. The `cron` npm package is unused

You have `"cron": "^3.1.0"` in your dependencies, but you're using Vercel Cron (which just hits your API route on a schedule). You don't need the `cron` package. Remove it to reduce your bundle.

### 15. No `vercel.json` with cron configuration

For Vercel Cron to work, you need a `vercel.json` file with the cron schedule defined:
```json
{
  "crons": [{
    "path": "/api/cron",
    "schedule": "0 0 * * *"
  }]
}
```

Without this, the cron job won't actually run.

### 16. No loading or error states on the dashboard

The dashboard is a server component with no `loading.tsx` or `error.tsx` boundaries. If the Supabase queries are slow, users see nothing. If they fail, users see the Next.js error page.

---

## Deployment Checklist

Before deploying to Vercel, make sure you:

- [ ] Add all environment variables to Vercel's project settings (not just `.env.local`)
- [ ] Create `vercel.json` with the cron schedule
- [ ] Set up the Stripe webhook endpoint URL to point to your production domain (`https://yourdomain.com/api/webhook`)
- [ ] Switch from `sk_live_` to `sk_test_` for staging/preview deployments
- [ ] Add a `CRON_SECRET` environment variable and verify it in the cron route
- [ ] Confirm `.env.local` is in `.gitignore`
- [ ] Set up Supabase RLS policies if you haven't already
- [ ] Add `middleware.ts` for auth-gated routes

---

## Summary

The app has a solid foundation, but it's **not ready to ship as-is**. The critical issues (unauthenticated cron endpoint, broken server-side auth, missing error handling on webhooks) could lead to security vulnerabilities, data loss, or a dashboard that simply doesn't work.

I'd prioritize in this order:
1. Fix the Supabase SSR auth setup (your dashboard is currently non-functional for logged-in users)
2. Secure the cron endpoint
3. Add error handling to the webhook and cron routes
4. Add the missing Stripe event handlers
5. Everything else

The good news is none of these are architectural rewrites -- they're all targeted fixes. You're probably a day or two of work away from being deploy-ready.

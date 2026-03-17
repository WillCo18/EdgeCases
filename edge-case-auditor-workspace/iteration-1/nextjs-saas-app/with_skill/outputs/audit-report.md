## Edge Case Audit — Next.js SaaS App — Pre-Deploy

**What I reviewed:**
- `app/api/webhook/route.ts` — Stripe webhook handler
- `app/api/auth/route.ts` — Auth sign-in endpoint
- `app/api/cron/route.ts` — Daily subscription check cron job
- `app/dashboard/page.tsx` — Dashboard server component
- `lib/supabase.ts` — Supabase client setup
- `package.json` — Dependencies
- `.env.local` — Environment configuration

**Build health:** Critical Issues — multiple issues that will cause runtime errors or data corruption under normal use.

---

### Critical — Will break in production

**1. Webhook insert will fail on duplicate events — Stripe sends retries**
- **Where:** `app/api/webhook/route.ts:20-28` — `checkout.session.completed` handler
- **What happens:** `.insert()` is used to create the subscription record. Stripe routinely delivers the same webhook event multiple times (retries on network hiccups, or if your endpoint was slow to respond). The second delivery will hit a duplicate key constraint on `stripe_subscription_id` (or create a duplicate row if there's no unique constraint, which is worse — you'll have two active subscriptions for one user).
- **When it triggers:** Any time Stripe retries a `checkout.session.completed` event, which happens regularly.
- **Fix:** Use `.upsert()` instead of `.insert()`, keyed on `stripe_subscription_id`:
  ```ts
  await supabaseAdmin.from('subscriptions').upsert({
    user_id: session.metadata.userId,
    stripe_customer_id: session.customer,
    stripe_subscription_id: session.subscription,
    plan: session.metadata.plan,
    status: 'active',
    current_period_end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
  }, { onConflict: 'stripe_subscription_id' });
  ```

**2. Cron endpoint has no authentication — anyone can trigger it**
- **Where:** `app/api/cron/route.ts:10` — `GET` handler
- **What happens:** The cron route is a public GET endpoint with no authorization check. Anyone who discovers the URL can trigger subscription expiration emails and database updates at will.
- **When it triggers:** Immediately, as soon as the URL is known or guessed (and `/api/cron` is an extremely common path).
- **Fix:** Verify the `Authorization` header against a secret (`CRON_SECRET`) that you set in Vercel:
  ```ts
  export async function GET(req: Request) {
    const authHeader = req.headers.get('authorization');
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    // ... rest of handler
  }
  ```

**3. Dashboard crashes when user has no subscription**
- **Where:** `app/dashboard/page.tsx:28-30` — accessing `subscription.plan`, `subscription.status`, `subscription.current_period_end`
- **What happens:** `.single()` returns `null` when no subscription row exists. The template then accesses `.plan` on `null`, throwing a runtime error that crashes the entire page with a 500 error.
- **When it triggers:** Every time a new user visits the dashboard before subscribing — the most common user journey for a SaaS app.
- **Fix:** Add a null check before rendering subscription data:
  ```tsx
  {subscription ? (
    <div>
      <p>Plan: {subscription.plan}</p>
      <p>Status: {subscription.status}</p>
      <p>Renews: {new Date(subscription.current_period_end).toLocaleDateString()}</p>
    </div>
  ) : (
    <p>No active subscription. <a href="/pricing">Choose a plan</a></p>
  )}
  ```

**4. Cron job crashes on null query result and has no error handling around Stripe/Resend calls**
- **Where:** `app/api/cron/route.ts:21` — `for (const sub of expiring)`
- **What happens:** If the Supabase query returns `{ data: null }` (e.g. network error, RLS issue), iterating over `null` throws `TypeError: expiring is not iterable`. Additionally, `stripe.subscriptions.retrieve()` (line 23) and `resend.emails.send()` (line 40) have no try/catch — a single failed Stripe API call or email send aborts the entire loop, leaving remaining subscriptions unchecked.
- **When it triggers:** Any transient Stripe API error, Resend outage, or Supabase connectivity blip during the cron run.
- **Fix:** Default `expiring` to an empty array and wrap the loop body in try/catch:
  ```ts
  const { data: expiring } = await supabaseAdmin...;
  for (const sub of (expiring ?? [])) {
    try {
      // ... existing logic
    } catch (err) {
      console.error(`Failed to process subscription ${sub.id}:`, err);
    }
  }
  ```

---

### High — Will bite you under realistic conditions

**5. Webhook metadata access is unsafe — `session.metadata` can be null**
- **Where:** `app/api/webhook/route.ts:21` — `session.metadata.userId`
- **What happens:** If the Checkout Session was created without metadata (or metadata was partially set), `session.metadata` is `null` and accessing `.userId` throws. The webhook returns a 500, Stripe retries it, it fails again, and eventually Stripe marks the endpoint as unhealthy.
- **When it triggers:** If any code path creates a Checkout Session without setting `metadata.userId` and `metadata.plan`, or if you test with a manually created session in the Stripe dashboard.
- **Fix:** Validate metadata before using it:
  ```ts
  if (!session.metadata?.userId || !session.metadata?.plan) {
    console.error('Checkout session missing required metadata', session.id);
    return NextResponse.json({ received: true }); // acknowledge to stop retries
  }
  ```

**6. Auth route returns raw session token in response body — leaks to client logs**
- **Where:** `app/api/auth/route.ts:16` — `return NextResponse.json({ user: data.user, session: data.session })`
- **What happens:** The full Supabase session object (including `access_token` and `refresh_token`) is returned in the JSON response body. This is visible in browser DevTools, any logging middleware, and network monitoring tools. The auth route also has no input validation — `req.json()` on a malformed body will throw an unhandled error.
- **When it triggers:** Every successful login.
- **Fix:** Return only what the client needs and wrap the body parse in try/catch:
  ```ts
  let email, password;
  try {
    ({ email, password } = await req.json());
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
  // After auth:
  return NextResponse.json({ user: data.user });
  ```
  Set the session via cookies using `@supabase/ssr` (which is already in your dependencies) rather than exposing it in the response.

**7. Supabase admin client is used in a server component without proper SSR cookie handling**
- **Where:** `lib/supabase.ts:3-6` — `supabase` client used in `app/dashboard/page.tsx:4`
- **What happens:** The `supabase` client created with `createClient` and the anon key has no access to the request cookies in a server component context. `supabase.auth.getUser()` will always return `null` because there's no session context. The dashboard auth check will never see a logged-in user.
- **When it triggers:** Every page load of the dashboard.
- **Fix:** Use `@supabase/ssr`'s `createServerClient` in server components, passing the cookies from the request. See [Supabase SSR docs](https://supabase.com/docs/guides/auth/server-side/nextjs).

---

### Worth noting — Low risk but worth a look

**8. `current_period_end` is hardcoded to 30 days from now instead of using Stripe's actual value**
- **Where:** `app/api/webhook/route.ts:27` — `new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)`
- **What happens:** The subscription period end date is calculated as "now + 30 days" rather than read from the Stripe subscription object. This will be wrong for annual plans, trial periods, or any non-standard billing interval.
- **When it triggers:** Any plan that isn't exactly a 30-day cycle.
- **Fix:** Retrieve the subscription from Stripe and use its `current_period_end`:
  ```ts
  const stripeSub = await stripe.subscriptions.retrieve(session.subscription as string);
  current_period_end: new Date(stripeSub.current_period_end * 1000).toISOString()
  ```

**9. Missing `.env.example` and `CRON_SECRET` / `RESEND_API_KEY` not documented**
- **Where:** Project root — no `.env.example` file
- **What happens:** When deploying to Vercel or onboarding another developer, there's no reference for which environment variables need to be set. `RESEND_API_KEY` and any future `CRON_SECRET` will be missed.
- **Fix:** Create a `.env.example` listing all required variables (without values).

**10. `.env.local` contains what appear to be live Stripe keys (`sk_live_`)**
- **Where:** `.env.local:4` — `STRIPE_SECRET_KEY=sk_live_xxxxx`
- **What happens:** Using live keys during development means test actions (webhook tests, checkout tests) will create real charges. If this file is accidentally committed to git, the keys are compromised.
- **When it triggers:** During any local development or testing.
- **Fix:** Use `sk_test_` keys for development. Ensure `.env.local` is in `.gitignore`.

---

**Verdict:** This app has several issues that will cause visible failures under normal user behaviour — the dashboard will crash for new users, the cron job is publicly accessible and will break on any transient error, and the Supabase auth flow won't work in server components as written. These need to be fixed before deploying.

**Suggested next action:** Fix the cron endpoint authentication (issue #2) first — it's the easiest to exploit and has the most immediate security impact. Then address the dashboard null crash (issue #3) and the Supabase SSR auth setup (issue #7), as those will affect every user on every page load.

---

> Want me to fix any of these? Or should I run a deeper audit on a specific area?

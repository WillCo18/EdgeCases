# Next.js Edge Case Reference

Use this file when auditing Next.js / frontend applications.
Only surface issues relevant to what has actually been built. Do not list everything.

---

## Environment & Config

- [ ] `.env.local` values used in client components — `NEXT_PUBLIC_` prefix missing means undefined at runtime with no error
- [ ] Env vars present locally but not set in Vercel/hosting environment
- [ ] `process.env` accessed in edge runtime (not supported — only `NEXT_PUBLIC_` vars available)
- [ ] Hardcoded API keys, URLs, or secrets in source files committed to git
- [ ] Missing fallback values — `process.env.THING || 'fallback'` not present, will be `undefined` silently
- [ ] No `.env.example` documenting required variables — deployment will miss env vars
- [ ] `.env.local` not in `.gitignore` — secrets committed to version control

---

## API Routes & Server Actions

- [ ] No input validation on POST body — will throw or behave unexpectedly on malformed input
- [ ] Missing `try/catch` around external calls — unhandled promise rejection crashes the route
- [ ] Response not always returned — early returns missing, route hangs if condition not met
- [ ] No rate limiting — route is publicly callable at unlimited volume
- [ ] CORS headers missing if route is called from a different origin
- [ ] Auth check missing or bypassable — route accessible without valid session
- [ ] Large payload not size-checked — no limit on request body size
- [ ] Cron/scheduled route has no auth — publicly callable GET endpoint (verify `CRON_SECRET` header for Vercel Cron)
- [ ] Error responses from Supabase/DB calls not checked — `{ data, error }` where error is silently ignored

---

## Authentication & Sessions

- [ ] Session token not validated server-side — only checked client-side (bypassable)
- [ ] Token expiry not handled — expired token causes silent failure or blank state
- [ ] Redirect after login goes to hardcoded path rather than the original intended destination
- [ ] Logout doesn't clear server-side session — client cookie deleted but server session persists
- [ ] Role/permission check missing on protected pages — only redirects if unauthenticated, not unauthorised
- [ ] OAuth callback URL not whitelisted in provider — works locally, breaks in production
- [ ] Session tokens returned in API response body — exposed to XSS, should use HttpOnly cookies instead
- [ ] Auth logic only enforced in UI — API endpoints are unprotected even though the button is hidden

---

## Server Components & Client Boundary

- [ ] Supabase/auth client in server component has no cookie access — `getUser()` always returns null without `@supabase/ssr` + `createServerClient`
- [ ] Server-only module (service role key, admin client) importable from client components — secret bundled into client JS
- [ ] Missing `'server-only'` import on modules that must not leak to client bundle
- [ ] User-supplied data interpolated into HTML templates without escaping — XSS / HTML injection in emails, server-rendered content

---

## Data Fetching

- [ ] `fetch` calls missing `{ cache: 'no-store' }` on routes that must be dynamic — serves stale data
- [ ] Error state not handled in UI — failed fetch renders blank or crashes
- [ ] Loading state missing — UI renders before data arrives, causes layout shift or hydration error
- [ ] Race condition on concurrent fetches — later response overwrites earlier one incorrectly
- [ ] Supabase/DB client instantiated per-request rather than singleton — connection pool exhausted under load (especially on serverless)
- [ ] `.single()` query result not null-checked — accessing properties on null crashes the page

---

## Database / Supabase

- [ ] `.insert()` used where `.upsert()` is needed — duplicate key error on re-runs or webhook retries
- [ ] Row Level Security disabled or not tested — data accessible without auth (the Moltbook breach exposed 1.5M API keys due to missing RLS)
- [ ] `null` values not handled in UI — `.map()` on null throws
- [ ] No error check on Supabase response — `{ data, error }` error ignored silently
- [ ] Realtime subscription not unsubscribed on component unmount — memory leak
- [ ] Hardcoded date calculations instead of using source-of-truth values (e.g., `Date.now() + 30 days` instead of Stripe's `current_period_end`)

---

## Deployment (Vercel)

- [ ] Build passes locally but fails on Vercel due to missing env vars
- [ ] `sharp` not installed for image optimisation — warning or fallback to unoptimised
- [ ] Middleware running in edge runtime accessing Node.js APIs — silent failure
- [ ] Functions exceeding 10s execution limit (Hobby) / 60s (Pro) — will timeout with no useful error
- [ ] Static generation hitting external API at build time — build fails if API is down
- [ ] Missing `vercel.json` for cron schedule — cron endpoint exists but is never called automatically
- [ ] No HTTPS configuration if self-hosting — Stripe and other webhooks require HTTPS in production
- [ ] Missing TypeScript devDependencies — build fails on Vercel even if it works locally

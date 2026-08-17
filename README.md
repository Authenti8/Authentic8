# Authenti8

Authenti8 is a consent-based interview endpoint-integrity platform. It helps
hiring teams identify active use of specifically supported real-time AI
interview-assistance tools using validated technical evidence—not behavioral
scoring.

This repository currently implements Phases 1–5:

- npm workspace monorepo foundation
- NestJS API and PostgreSQL migration
- animated public marketing website
- email/password and Google identity authentication
- email verification and password recovery
- revocable database sessions
- transactional organization onboarding
- strict default interview policy and pilot workspace initialization

The native candidate verifier, calendar synchronization, billing, telemetry,
detection engine, and interview reporting are specified in
[`docs/phases.md`](docs/phases.md) and implemented in later phases.

## Requirements

- Node.js 20.19 or newer
- npm 10 or newer
- A Supabase project

## Local setup

```bash
npm install
cp .env.example .env
```

Set `SUPABASE_URL` and one server key in `.env`. Prefer the modern
`SUPABASE_SECRET_KEY`; `SUPABASE_SERVICE_ROLE_KEY` supports Supabase's legacy
service-role JWT. Both are privileged server-only values and must never use a
`NEXT_PUBLIC_` prefix or be sent to the browser. Google login also requires a
public `SUPABASE_PUBLISHABLE_KEY` or legacy `SUPABASE_ANON_KEY`; the API uses it
only to exchange Google's verified ID token with Supabase Auth.

Environment values needed for the starter:

| Variable | Needed now | Purpose |
| --- | --- | --- |
| `APP_ORIGIN` | Yes | Public origin for the single web + API deployment; must be explicit HTTPS in production |
| `AUTH_ORIGIN` | Production subdomains | Login and signup origin, for example `https://auth.authenti8.com` |
| `ONBOARDING_ORIGIN` | Production subdomains | Company setup origin, for example `https://onboarding.authenti8.com` |
| `DASHBOARD_ORIGIN` | Production subdomains | Authenticated application origin, for example `https://dashboard.authenti8.com` |
| `PAYMENT_ORIGIN` | Production subdomains | Billing origin, for example `https://payment.authenti8.com` |
| `SESSION_COOKIE_DOMAIN` | Production subdomains | Shared parent cookie domain, for example `.authenti8.com` |
| `API_ORIGIN` | Local only | Standalone Nest API used by the local Next.js development rewrite; do not set it in Vercel |
| `SUPABASE_URL` | Yes | Supabase project URL used by the server-side Data API client |
| `SUPABASE_SECRET_KEY` | Yes* | Preferred server-only secret key; use this or the legacy service-role key |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes* | Legacy server-only fallback; do not configure both unless rotating keys |
| `SUPABASE_PUBLISHABLE_KEY` | For Google login* | Preferred public key used for the Supabase Auth identity exchange |
| `SUPABASE_ANON_KEY` | For Google login* | Legacy public-key fallback; configure one public key, not both |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | For Google login | Google OAuth web-application credentials |
| `GOOGLE_CALLBACK_URL` | For Google login | Must exactly match the authorized redirect URI in Google Cloud |
| `GOOGLE_CALENDAR_CALLBACK_URL` | For Calendar | Separate Calendar OAuth redirect URI |
| `INTEGRATION_ENCRYPTION_KEY` | For Calendar | Base64-encoded 32-byte provider-token key |
| `DODO_PAYMENTS_API_KEY`, `DODO_PAYMENTS_WEBHOOK_KEY` | For billing | Dodo test API and webhook secrets |
| `DODO_PROFESSIONAL_PRODUCT_ID` | For billing | Recurring $1,000/month product ID |
| `DODO_EXTRA_INTERVIEW_PRODUCT_ID` | For billing | One-time $5 product ID |
| `DODO_PROFESSIONAL_AMOUNT_MINOR`, `DODO_EXTRA_INTERVIEW_AMOUNT_MINOR` | For delegated billing | Trusted provider prices in minor currency units; verified payments must match |
| `TRUSTED_PROXIES` | Yes | Known proxy IPs/CIDRs used to resolve the real client IP; keep API ingress private to them |
| `SMTP_*` | Production only | Sends verification and password-reset emails |
| `AUTH_MAIL_ENCRYPTION_KEY` | Production only | Base64-encoded 32-byte key that encrypts pending auth-email tokens in the durable outbox |
| `CRON_SECRET` | Production only | Protects the mail-worker endpoint; use the same value in Vercel and Supabase Vault |
| `NEXT_PUBLIC_WINDOWS_AGENT_INSTALLER_URL` | Before candidate rollout | HTTPS URL for the signed `Authenti8VerifySetup.exe`; it may be omitted until the GitHub release exists |
Apply migrations using **Supabase Dashboard → SQL Editor**:

- For an empty project, apply `001` through `034` once, in numeric order.
- For an existing Authenti8 project, first run
  `SELECT version FROM schema_migrations ORDER BY applied_at;`, then apply only
  the missing files in numeric order. A project already on `027` should apply
  `028`, `029`, `030`, `031`, `032`, `033`, and `034`.

Do not rerun an applied migration. Migrations `007` and `008` install the
server-only RPC functions and grant them only to Supabase's `service_role`.
Migration `009` links each application user to one Supabase Auth user while
preserving the existing application user and organization membership.
Migrations `010` and `011` add billing, credits, dashboard aggregates,
encrypted Calendar integration state, and interview synchronization.
Migration `012` reapplies the Starter onboarding RPC for databases that had
already installed the original migration `008`.
Migration `013` installs the dashboard overview and interview-list read models.
Migration `014` adds automatic credit reservation and reconciles outstanding
reservations whenever a subscription or purchased-credit entitlement changes.
Migration `015` adds the Dodo customer-portal context and prevents a second
Professional checkout while an existing subscription can still be restored.
Migration `016` forwards billing cancellation and checkout-recovery changes to
existing databases and preserves intentional credit releases during calendar sync.
Migration `017` preserves provider-subscription ownership so delayed recovery
events cannot revive a superseded subscription. Migration `018` adds protected
interview state and credit transitions. Migration `019` adds the durable Dodo
webhook inbox used to acknowledge provider deliveries before processing.
Migration `020` binds subscription lifecycle events to authorized provider
records, prevents stale recoveries from superseding newer checkouts, and limits
self-service extra credits to Starter and Professional workspaces.
Migrations `028` and `029` add single-use candidate-device enrollment, ephemeral
Ed25519 device binding, and signed ordered agent telemetry. Apply them after
`027` before testing Authenti8 Verify.
Migration `030` makes enrollment replay idempotent and enforces atomic monitoring
start, stop, credit, and telemetry ordering for databases that already applied
`028` and `029`.
Migration `031` makes exact signed-event retries idempotent so a Windows agent
can recover its DPAPI-protected event chain after a crash.
Migration `032` lets completed or just-expired sessions expose their enrolled
public key only long enough for the ingestion RPC to accept an exact signed replay.
Migration `033` makes a completed device enrollment recoverable with the same
DPAPI-protected key if its successful HTTP response was lost.
Migration `034` permits signed events captured before the authorized end, plus
the terminal stop event, to arrive during a bounded five-minute delivery grace.
Migration `007` also disables the obsolete `authenti8_backend` login used by
earlier installations. The application then uses HTTPS through Supabase's Data
API—there is no database URL, connection pooler, or migration credential in the
running application.

Production auth email is delivered by a protected outbox worker rather than in
the signup or password-reset request. Generate `CRON_SECRET` with
`openssl rand -base64 32`, add it to the API's Vercel environment, then configure
the 10-second Supabase Cron job in
`infrastructure/supabase/mail-worker-cron.example.sql`. This schedule is
required for email delivery and retries on serverless deployments. It also
drains durable billing webhooks every 10 seconds, drains Calendar synchronization
jobs every minute, recovers integrations that have been stale for 30 minutes,
and checks every five minutes for channels that are close to expiry. Cron history
is retained for seven days. Re-run this setup file after applying migration `019`;
replace `YOUR-VERCEL-DOMAIN` with the deployment host and keep its Vault secret
identical to the Vercel `CRON_SECRET`.

## Vercel deployment

Authenti8 deploys as one Next.js project. The landing page and dashboard are
served from `/`, and the existing NestJS application is mounted inside the same
deployment at `/api/v1`. The legacy `/v1` path remains an alias so existing
health checks keep working while integrations move to the canonical path.

For the existing `authentic8-api` Vercel project:

1. Set **Root Directory** to `apps/web` and **Framework Preset** to Next.js.
2. Enable **Include source files outside of the Root Directory in the Build Step**
   so the workspace API and shared packages are available.
3. Attach `authenti8.com`, `auth.authenti8.com`, `onboarding.authenti8.com`,
   `dashboard.authenti8.com`, and `payment.authenti8.com` to Production.
4. Configure the production origins and shared session domain:
   `APP_ORIGIN=https://authenti8.com`,
   `AUTH_ORIGIN=https://auth.authenti8.com`,
   `ONBOARDING_ORIGIN=https://onboarding.authenti8.com`,
   `DASHBOARD_ORIGIN=https://dashboard.authenti8.com`,
   `PAYMENT_ORIGIN=https://payment.authenti8.com`, and
   `SESSION_COOKIE_DOMAIN=.authenti8.com`.
5. Remove `API_ORIGIN`; it is intentionally not used in production.
6. Set `GOOGLE_CALLBACK_URL=https://auth.authenti8.com/api/v1/auth/google/callback`.
7. Set `GOOGLE_CALENDAR_CALLBACK_URL=https://dashboard.authenti8.com/api/v1/integrations/google/callback`.
8. Register both callback URIs in the same Google Cloud OAuth client, then
   redeploy the current commit without creating another Vercel project.

All existing server-only Supabase, Google, SMTP, encryption, and cron variables
stay on this same Vercel project. After deployment, `/` serves the website,
`/api/v1/health` serves API health, and Supabase Cron calls
`/api/v1/internal/mail/drain`, `/api/v1/internal/integrations/sync`, and
`/api/v1/internal/integrations/renew`. The same Supabase Cron configuration drains
verified Dodo webhook events through `/api/v1/internal/billing/webhooks/drain`.

Install the Git hooks:

```bash
npm run hooks:install
```

Start the Next.js web app and NestJS API together:

```bash
npm run dev
```

- Web: `http://localhost:3000`
- API health: `http://localhost:3000/api/v1/health`

When SMTP is not configured in development, signup and password-recovery pages
display a clearly labelled preview link. Production never returns authentication
tokens in API responses.

## Google login

Create a Google OAuth web application and configure:

```text
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
GOOGLE_CALLBACK_URL=http://localhost:3000/api/v1/auth/google/callback
```

In **Supabase Dashboard → Authentication → Sign In / Providers → Google**, enable
Google and configure the same Google client ID and secret. Keep Google Cloud's
authorized redirect URI pointed at Authenti8's callback above (or its production
equivalent); the Authenti8 callback exchanges Google's ID token with Supabase
Auth and then maps it to the existing application account. After migration `009`,
the next successful Google login backfills existing accounts into Supabase Auth
without creating a second workspace.

Google login requests identity scopes only (`openid`, `email`, and `profile`).
Google Calendar authorization is intentionally separate and belongs to Phase 9.

## Repository structure

```text
apps/
  web/                    Next.js recruiter and marketing application
  api/                    NestJS API
  recruiter-extension/    Reserved for the Google Meet recruiter panel
  candidate-extension/    Reserved for browser-tool verification
  windows-agent/          Reserved for the Windows verifier
  macos-agent/            Reserved for the macOS verifier
packages/
  contracts/              Shared public API types
  event-schemas/          Canonical telemetry envelope and event types
  detection-rules/        Shared rule-definition contracts
  validation/             Shared event validation
  security/               Shared signing and digest contracts
  ui/                     Shared visual tokens and status types
infrastructure/
  postgres/               Versioned PostgreSQL migrations
docs/                     Product and system-design specifications
```

## Quality gates

Every commit runs both guardians:

- Quality: ESLint, 500-line authored source files, 50-line functions, and strict
  TypeScript checks.
- Functionality: API tests and complete production builds for shared contracts,
  API, and web.

Run them manually with:

```bash
npm run guardian
```

Pull requests and pushes to `main` run the same guardian in GitHub Actions.
Configure the `guardian` job as a required branch-protection check before the
first deployment so failing changes cannot be merged or deployed.

## Security behavior implemented

- Passwords use salted `scrypt` hashes.
- Verification, reset, OAuth state, and session tokens are random and stored as
  SHA-256 hashes.
- Verification and reset tokens are single-use and expire.
- Sessions are revocable, expire after seven days, and use `HttpOnly`,
  `SameSite=Lax` cookies.
- Password reset revokes every existing session.
- Signup and password recovery use generic responses to reduce account
  enumeration.
- API DTOs reject unknown or invalid fields.
- Cross-origin mutations are blocked.
- OAuth state is bound to a short-lived HttpOnly browser cookie.
- Authentication rate limits are atomic and shared through Supabase Postgres.
- Login throttling is enforced by trusted client IP; account counters are not
  used as lockouts that an attacker could trigger against another user.
- Every Authenti8 table has RLS enabled; Supabase browser roles have no policy.
- Privileged operations are narrow transactional RPC functions callable only
  with the server-side Supabase secret/service-role key.
- The running API has no database password, connection string, or pooler.
- Protected data is checked against the database close to the API data source.
- Organization creation, membership, policy, subscription, credit ledger, and
  audit records are written in one transaction.

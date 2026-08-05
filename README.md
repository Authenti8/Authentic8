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
`NEXT_PUBLIC_` prefix or be sent to the browser. A publishable/anon key is not
needed by the Phase 1–5 application.

Environment values needed for the starter:

| Variable | Needed now | Purpose |
| --- | --- | --- |
| `APP_ORIGIN` | Yes | Public origin for the single web + API deployment; must be explicit HTTPS in production |
| `API_ORIGIN` | Local only | Standalone Nest API used by the local Next.js development rewrite; do not set it in Vercel |
| `SUPABASE_URL` | Yes | Supabase project URL used by the server-side Data API client |
| `SUPABASE_SECRET_KEY` | Yes* | Preferred server-only secret key; use this or the legacy service-role key |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes* | Legacy server-only fallback; do not configure both unless rotating keys |
| `SUPABASE_PUBLISHABLE_KEY` | No | Reserved for future browser-side Supabase features |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | For Google login | Google OAuth web-application credentials |
| `GOOGLE_CALLBACK_URL` | For Google login | Must exactly match the authorized redirect URI in Google Cloud |
| `TRUSTED_PROXIES` | Yes | Known proxy IPs/CIDRs used to resolve the real client IP; keep API ingress private to them |
| `SMTP_*` | Production only | Sends verification and password-reset emails |
| `AUTH_MAIL_ENCRYPTION_KEY` | Production only | Base64-encoded 32-byte key that encrypts pending auth-email tokens in the durable outbox |
| `CRON_SECRET` | Production only | Protects the mail-worker endpoint; use the same value in Vercel and Supabase Vault |
Apply migrations using **Supabase Dashboard → SQL Editor**:

- For an empty project, apply `001` through `008` once, in numeric order.
- For an existing Authenti8 project, first run
  `SELECT version FROM schema_migrations ORDER BY applied_at;`, then apply only
  the missing files. A project already on `006` should apply `007` and `008`.

Do not rerun an applied migration. Migrations `007` and `008` install the
server-only RPC functions and grant them only to Supabase's `service_role`.
Migration `007` also disables the obsolete `authenti8_backend` login used by
earlier installations. The application then uses HTTPS through Supabase's Data
API—there is no database URL, connection pooler, or migration credential in the
running application.

Production auth email is delivered by a protected outbox worker rather than in
the signup or password-reset request. Generate `CRON_SECRET` with
`openssl rand -base64 32`, add it to the API's Vercel environment, then configure
the 10-second Supabase Cron job in
`infrastructure/supabase/mail-worker-cron.example.sql`. This schedule is
required for email delivery and retries on serverless deployments. The same
setup retains seven days of cron execution history for operational debugging.

## Vercel deployment

Authenti8 deploys as one Next.js project. The landing page and dashboard are
served from `/`, and the existing NestJS application is mounted inside the same
deployment at `/api/v1`. The legacy `/v1` path remains an alias so existing
health checks keep working while integrations move to the canonical path.

For the existing `authentic8-api` Vercel project:

1. Set **Root Directory** to `apps/web` and **Framework Preset** to Next.js.
2. Enable **Include source files outside of the Root Directory in the Build Step**
   so the workspace API and shared packages are available.
3. Keep `APP_ORIGIN=https://authentic8-api.vercel.app`.
4. Remove `API_ORIGIN`; it is intentionally not used in production.
5. Set `GOOGLE_CALLBACK_URL=https://authentic8-api.vercel.app/api/v1/auth/google/callback`.
6. Keep the same callback URI in the Google Cloud OAuth client.
7. Redeploy the current commit without creating another Vercel project.

All existing server-only Supabase, Google, SMTP, encryption, and cron variables
stay on this same Vercel project. After deployment, `/` serves the website,
`/api/v1/health` serves API health, and Supabase Cron calls
`/api/v1/internal/mail/drain`.

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

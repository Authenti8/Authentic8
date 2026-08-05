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
- A Supabase project (or PostgreSQL 17 with Docker for the local fallback)

## Local setup

```bash
npm install
cp .env.example .env
cp .env.migration.example .env.migration
```

Open `.env.migration` and paste the Direct Connection string from **Supabase
Dashboard → Connect**. Migrations run as the database owner; this file must
never be injected into the API or web deployment. The API uses the dedicated,
non-owner `authenti8_backend` role created by the migrations. Supabase API keys
are not required for Phases 1–5.

Environment values needed for the starter:

| Variable | Needed now | Purpose |
| --- | --- | --- |
| `APP_ORIGIN` | Yes | Public web origin; must be explicit HTTPS in production |
| `API_ORIGIN` | Yes | API destination used by the Next.js rewrite |
| `DATABASE_URL` | Yes | Session Pooler URL for the non-owner `authenti8_backend` API role |
| `DATABASE_POOL_MAX` | Yes | Maximum PostgreSQL connections per API instance; defaults to 5 |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | For Google login | Google OAuth web-application credentials |
| `GOOGLE_CALLBACK_URL` | For Google login | Must exactly match the authorized redirect URI in Google Cloud |
| `TRUSTED_PROXIES` | Yes | Known proxy IPs/CIDRs used to resolve the real client IP; keep API ingress private to them |
| `SMTP_*` | Production only | Sends verification and password-reset emails |
| `AUTH_MAIL_ENCRYPTION_KEY` | Production only | Base64-encoded 32-byte key that encrypts pending auth-email tokens in the durable outbox |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | Not yet | Reserved for later Supabase Storage integration |

`DATABASE_MIGRATION_URL` exists only in `.env.migration` or in a dedicated
migration job. The running API rejects deployments that expose this owner
credential to it.

Apply the migrations using the owner connection:

```bash
npm run db:migrate
```

In the Supabase SQL editor, give the generated backend role a unique password:

```sql
ALTER ROLE authenti8_backend LOGIN PASSWORD 'GENERATE_A_LONG_UNIQUE_PASSWORD';
```

Put that role and password into the `DATABASE_URL` Session Pooler value shown in
`.env.example`. Do not use the `postgres` owner URL for application traffic.
Then install the Git hooks:

```bash
npm run hooks:install
```

For a local database, start Docker, put the documented owner URL in
`.env.migration`, and run the migration:

```bash
docker compose up -d postgres
npm run db:migrate
docker compose exec postgres psql -U authenti8 -d authenti8
```

Run `\password authenti8_backend` inside `psql`, then put the local backend-role
URL from `.env.example` into `DATABASE_URL`.

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
- Authentication rate limits are atomic and shared through PostgreSQL.
- Login throttling is enforced by trusted client IP; account counters are not
  used as lockouts that an attacker could trigger against another user.
- Every Authenti8 table has RLS enabled; Supabase browser roles have no policy,
  while the dedicated non-owner backend role is explicitly permitted.
- The database owner credential is reserved for migrations and is never used by
  the running API.
- Protected data is checked against the database close to the API data source.
- Organization creation, membership, policy, subscription, credit ledger, and
  audit records are written in one transaction.

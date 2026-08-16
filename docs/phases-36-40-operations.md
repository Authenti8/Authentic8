# Phases 36–40 Operations

Phases 36–40 add the platform-operations boundary used for controlled pilots. Apply database
migrations `040_admin_privacy_retention.sql`, `041_accuracy_observability_pilot.sql`,
`042_atomic_accuracy_release.sql`, and `043_admin_recovery_controls.sql` in that order after
migration 039. Do not enable the scheduled operations or accuracy-release workflow until all four
migrations have completed successfully.

## Platform administrators

Platform access is deliberately separate from workspace roles. Bootstrap the first two operators
with their existing Authenti8 user IDs:

```sql
INSERT INTO platform_administrators(user_id) VALUES
  ('first-user-uuid'), ('second-user-uuid');
```

The internal panel is available at `/admin`. Opening it creates a customer-data-access audit event.
Sensitive mutations use `POST /v1/admin/changes`, then a different operator must approve the request
through `POST /v1/admin/changes/approve`. Raw telemetry has no admin mutation API.

## Scheduled operations

Invoke these endpoints with `Authorization: Bearer <CRON_SECRET>` from the production scheduler:

- `POST /api/v1/internal/operations/retention` once daily.
- `POST /api/v1/internal/operations/recover` every minute.
- Existing interview, calendar, report, mail, and billing drains keep their current schedules.

Retention defaults to 30 days for evidence and 90 days for reports and candidate identity. Configure
an organization before its first interview by inserting or updating `organization_retention_policies`.
Expired interview reports return unavailable, raw evidence is removed, identity is anonymized, and a
non-identifying deletion audit remains. Billing ledgers and immutable audit records are preserved.

Operational failure context must contain identifiers and safe diagnostic values only. The database
removes common secret fields (`token`, `secret`, `password`, and `authorization`) and moves failures
to `DEAD` after five attempts. A dead-letter entry blocks the pilot gate until it is resolved.

## Accuracy release gate

Run the `Release Accuracy Gate` workflow for every candidate-agent release. Native device automation
must exercise the packaged installer and export one `NATIVE_E2E` result per platform containing the
installer SHA-256 and current commit. Provision locked self-hosted runners with the labels
`authenti8-windows-accuracy` and `authenti8-macos-accuracy`; each runner must expose
`AUTHENTI8_NATIVE_ACCURACY_DRIVER` plus the platform signing and notarization configuration. The
workflow builds the candidate from the immutable dispatched commit, executes the driver against that
fixed output path, uploads the exact tested binary with its result, and verifies both again after transfer. It
rejects stale commits, fixture evidence, malformed digests, false confirmations, missed supported
detections, and unhealthy coverage. The signed Windows and macOS results are recorded and promoted in
one database transaction, so either both production versions advance or neither does.

Configure `ACCURACY_UPLOAD_SECRET` as a production-environment secret. Configure
`AUTHENTI8_API_ORIGIN`, `AUTHENTI8_CHROME_EXTENSION_ID`, `AUTHENTI8_RULE_PACK_PUBLIC_KEY`, and
`AUTHENTI8_UPDATE_PUBLIC_KEY` as production-environment variables. Restrict the GitHub `production`
environment deployment branches to
`main`; the workflow also rejects dispatches from every other ref. Missing native runners, drivers,
binaries, signing material, or evidence fails closed. A result is accepted only when it names the
currently enabled, published, and unexpired rule pack for its platform.
Guardian uses `npm run accuracy:fixtures` only for deterministic matcher regression tests; fixture
results carry `MATCHER_FIXTURE` provenance and are rejected by both the release harness and API.

The checked-in manifests are the regression contract, not release evidence. Changing an expected
result to make CI green is prohibited. Native automation owns the release observations; the native
agent matcher and telemetry-integrity tests continue to run under Guardian.

## Pilot gate

`GET /api/v1/admin/pilot-readiness` and `/admin` require all of the following. Accuracy rows are
stored independently per operating-system version; the current pilot specifically requires Windows
11 and macOS 15 results produced by agent builds whose package versions match their manifests:

- Passing Windows and macOS accuracy runs.
- Each run matches the exact minimum production agent version, source commit, and active rule pack.
- Each registered production version includes the lowercase SHA-256 artifact digest, and readiness
  requires the accuracy run to attest that exact digest.
- No unresolved dead-letter failures.
- Unexpired Windows, macOS, and Chrome rule packs.
- An active Google Calendar integration for every enabled pilot partner.
- At least one enabled design partner in `pilot_partners`.

The gate is intentionally fail-closed. Unsupported platforms, missing permissions, interrupted
monitoring, expired rules, and missing test coverage must never be presented as fully verified.

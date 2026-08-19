# Authenti8 Playwright and Scale Testing Plan

## Purpose

This plan validates Authenti8 as a complete multi-tenant cheating-detection SaaS for more than
100 organizations, with at least 10 HR interviewers per organization conducting protected
candidate interviews.

Playwright is responsible for browser workflows and role behavior. It must be combined with:

- Playwright for browser, dashboard, candidate, and Chrome extension workflows.
- k6 or Artillery for organization, API, telemetry, queue, and concurrency load.
- Native Windows and macOS accuracy harnesses for real cheating-tool detection and false-positive
  validation.

Playwright alone cannot prove native process detection, evidence accuracy, or production capacity.

## Target Operating Model

The minimum scale model is:

- 100 to 150 organizations.
- One Owner per organization.
- Multiple Managers per organization.
- At least 10 HR interviewers per organization.
- 1,000 to 1,500 independently authenticated interviewers.
- Independent Google Calendar connections for every interviewing Owner, Manager, and HR member.
- Organization-level subscription credits.
- HR-specific interview allocations.
- Concurrent candidate verification, monitoring, live logs, and report generation.

Two types of scale must be tested separately:

1. Onboarded scale: 100+ organizations and 1,000+ interviewers using routine SaaS features.
2. Active scale: increasing numbers of simultaneous protected interviews generating live evidence.

## Phase 51 — Test Foundation

Create a production-like environment that is completely isolated from production:

- Dedicated PostgreSQL or Supabase test database.
- Dedicated object storage, queues, encryption keys, and worker secrets.
- Dedicated email inbox or local email-capture service.
- Dodo billing sandbox and webhook simulator.
- Google OAuth test credentials and controlled Calendar adapter.
- Playwright projects for desktop Chromium and recruiter-extension Chromium.
- Reusable authenticated states for Founder, Owner, Manager, HR, and candidate personas.
- Unique test-run identifiers for all generated data.
- Deterministic test clock where expiry and scheduling behavior is involved.
- Automated data cleanup after each run.
- Screenshots, videos, traces, console output, API logs, and database diagnostics on failure.

Tests must use accessible roles, labels, and text selectors where possible. Stable `data-testid`
attributes should be added only when semantic selectors cannot identify an element reliably.

No production secrets or customer data may be used.

## Phase 52 — Tenant and Role Isolation

Seed at least 100 organizations with one Owner, Managers, and 10 HR interviewers each.

Validate the permission matrix:

| Capability | Owner | Manager | HR |
| --- | --- | --- | --- |
| Manage organization | Yes | Limited | No |
| Invite Manager | Yes | No | No |
| Invite HR | Yes | Yes | No |
| Connect own calendar | Yes | Yes | Yes |
| Conduct protected interviews | Yes | Yes | Yes |
| Allocate HR credits | Yes | Only when authorized | No |
| Purchase credits | Yes | Only with active delegation | No |
| View another organization | No | No | No |

Attempt cross-tenant access by changing:

- Organization IDs.
- Interview IDs.
- Member IDs.
- Wallet IDs.
- Calendar integration IDs.
- Invitation tokens.
- Candidate verification tokens.
- Request bodies and route parameters.
- Cookies and authenticated browser state.

Every unauthorized attempt must fail safely without exposing whether the target record exists.
No data, credits, reports, evidence, members, or calendar credentials may cross organizations.

## Phase 53 — Authentication and Onboarding

Playwright must cover:

- Signup and verified-email onboarding.
- Invalid and expired verification links.
- Login and logout.
- Password reset, expiration, reuse, and session revocation.
- Google login.
- Organization creation.
- Invitation issuance, cancellation, expiration, and acceptance.
- Invitation email binding.
- Duplicate and concurrent invitations.
- Existing-user invitation acceptance.
- Suspended and removed members with existing sessions.
- Role-specific navigation and protected routes.
- Founder bootstrap and Founder dashboard authorization.

Authentication tests must confirm that sensitive tokens never appear in browser logs, analytics,
URLs after completion, or failure messages.

## Phase 54 — Team, Wallet, Credit, and Billing Tests

Validate UI behavior and database-ledger invariants together:

- Starter creates exactly 10 usable organization credits.
- Allocating five credits to an HR member leaves five unallocated organization credits.
- The HR member can reserve or consume only five interviews.
- The sixth interview attempt fails without overspending the organization or HR wallet.
- Two concurrent reservations cannot consume the same credit.
- Cancelled and unstarted interviews release reservations.
- Monitoring consumes exactly one credit.
- Retries never consume a second credit.
- Duplicate and replayed billing webhooks never add credits twice.
- Owners can add and remove HR allocations.
- Managers can purchase only with an active Owner delegation and within configured limits.
- HR members can never purchase credits.
- Delegation expiry and revocation take effect immediately.
- Subscription upgrades, downgrades, renewal, cancellation, past-due state, and refunds reconcile
  credits correctly.
- Enterprise payments activate the correct agreement and add credits exactly once.
- Invalid signatures, wrong products, wrong amounts, reordered events, and stale webhooks fail safely.

Every financial test must inspect the immutable ledger and reservation records, not only dashboard
totals.

## Phase 55 — Per-Interviewer Google Calendar Tests

Every Owner, Manager, and HR interviewer must be able to connect an independent Google Calendar.

Test:

- Ten HR users connect ten independent calendars in one organization.
- Owners and Managers connect their own calendars.
- Tokens, sync states, channels, and errors remain member-scoped.
- Shared events across Owner, Manager, and HR calendars create one canonical interview.
- Every recurring occurrence receives a distinct canonical identity.
- Rescheduling updates the correct occurrence.
- Candidate, time, and organizer changes reconcile safely.
- Cancellation removes only the affected source mapping.
- Disconnecting one member does not disconnect another member.
- Suspending or removing a member invalidates their calendar integration and queued work.
- Token refresh, revoked consent, expired access, pagination, stale sync, webhook replay, and full
  resynchronization recover correctly.
- A completed report remains canonical when another calendar has an older lifecycle copy.
- Every source mapping moves to the selected canonical survivor during duplicate reconciliation.
- Calendar reconciliation never duplicates or loses a credit reservation.

Most CI scenarios should use a controlled Google Calendar adapter. A smaller scheduled suite should
exercise real Google OAuth and Calendar test accounts to detect provider-contract regressions.

## Phase 56 — Candidate Verification Lifecycle

Playwright must exercise:

- Candidate opens the correct verification link.
- Invalid, malformed, expired, consumed, or wrong-candidate tokens.
- Candidate disclosure and explicit consent.
- Explicit consent decline.
- Supported and unsupported operating systems.
- Device enrollment and platform validation.
- Incorrect, expired, and replayed enrollment credentials.
- Monitoring attempts before or after the authorized window.
- Candidate network interruption and reconnection.
- Native agent exit and restart.
- Interview rescheduling after verification.
- Interview cancellation after enrollment.
- Automatic monitoring stop at the authorized end condition.
- Repeated browser submissions and concurrent candidate actions.

Monitoring must never begin before consent. A declined candidate must never produce an active
monitoring session or consumed credit.

## Phase 57 — Native Cheating-Detection Tests

Real detection must be tested on separate Windows and macOS runners. Browser tests must not mock a
successful cheating result and treat it as proof of detection accuracy.

For every supported operating system, application version, and rule pack, run:

- Supported cheating tool not installed.
- Installed but closed.
- Running but not actively used.
- Actively used during the interview.
- Started midway through the interview.
- Stopped and restarted.
- Renamed executable or moved installation directory.
- Multiple supported tools.
- Legitimate software with similar process, window, audio, or network behavior.
- Missing operating-system permissions.
- Agent restart during monitoring.
- Offline evidence buffering and later delivery.
- Duplicate, delayed, reordered, or replayed telemetry.
- Invalid signatures, wrong device identity, and tampered evidence.

Assertions must prove:

- Evidence belongs to the correct organization, interview, interviewer, candidate, and enrolled
  device.
- Forged, replayed, reordered, or cross-session evidence is rejected.
- Live detection is visible only to authorized organization members.
- Final results are reproducible from stored signed evidence.
- Monitoring coverage is separate from the detection conclusion.
- Insufficient monitoring never produces an unjustified clean conclusion.
- Supported-tool detection and clean-corpus false-positive thresholds meet the signed accuracy gate.

## Phase 58 — Live Interview and Extension UI

Test both recruiter surfaces:

- Dashboard live-session view.
- Chrome extension overlay inside Google Meet.

Cover:

- Logs arrive in timestamp and sequence order.
- Monitoring health and cheating detection use distinct presentation and severity.
- The overlay can be dragged, collapsed, reopened, and repositioned.
- Position preferences survive navigation or extension restart where intended.
- The overlay remains private under the documented screen-sharing workflow.
- Reconnection restores the timeline without duplicating messages.
- Multiple simultaneous interviews never mix events.
- Owners, Managers, and HR members see only interviews permitted by organization and responsibility.
- Keyboard navigation, focus, accessible names, zoom, and supported display sizes.
- Browser refresh, extension service-worker restart, Meet navigation, and temporary backend outage.

The extension suite should run through Playwright persistent Chromium contexts. A controlled Google
Meet smoke suite should run separately because external provider UI can change independently.

## Phase 59 — Load, Concurrency, Spike, and Soak Testing

Playwright should not generate the full performance load. Use k6 or Artillery for service traffic,
with deterministic telemetry and calendar-event generators.

### Onboarded Scale

Maintain:

- 100 to 150 active organizations.
- 1,000 to 1,500 active HR interviewers.
- Member dashboards, invitations, wallet operations, notifications, calendar sync, and routine
  report access.

### Concurrent Interview Scale

Ramp through:

- 50 simultaneous interviews.
- 100 simultaneous interviews.
- 250 simultaneous interviews.
- 500 simultaneous interviews.
- 1,000 simultaneous interviews.

Each simulated interview must perform realistic lifecycle traffic:

1. Calendar discovery or interview creation.
2. Credit reservation.
3. Candidate verification and consent.
4. Device enrollment.
5. Monitoring startup.
6. Signed heartbeat and telemetry delivery.
7. Live recruiter-event consumption.
8. Monitoring completion.
9. Evidence aggregation and report generation.
10. Credit consumption and ledger verification.

### Load Profile

Use at least:

```text
15-minute warm-up
30-minute steady state
10-minute spike to twice expected concurrency
30-minute recovery and backlog drain
2-to-4-hour soak test
```

Introduce controlled failures during load:

- API instance restart.
- Worker restart.
- Database connection pressure.
- Queue delay.
- Temporary object-storage failure.
- Duplicate provider webhooks.
- Calendar webhook bursts.
- Telemetry retry storms.
- Partial network outage.

### Required Measurements

Collect:

- API p50, p95, and p99 latency.
- Error, timeout, and retry rates.
- Database connections, CPU, slow queries, and lock waits.
- Queue depth, oldest-job age, and dead-letter volume.
- Telemetry acknowledgement and processing delay.
- Live-log delivery delay.
- Calendar webhook and full-sync completion delay.
- Report-generation duration.
- Missing, duplicate, rejected, and reordered event counts.
- Credit-ledger and reservation inconsistencies.
- Memory, CPU, storage, and network saturation.

Initial release objectives:

- Read API p95 below 500 milliseconds.
- Normal mutation p95 below 1 second.
- Telemetry acknowledgement p95 below 500 milliseconds.
- Live-log delivery p95 below 2 seconds.
- Report ready p95 below 60 seconds after interview completion.
- Error rate below 0.5 percent at supported steady-state load.
- Zero cross-tenant data leaks.
- Zero duplicate credit consumption.
- Zero accepted replayed or invalid evidence.

These thresholds should be adjusted only from measured baselines and documented capacity decisions.

## Phase 60 — Production Release Gate

Production deployment must be blocked unless all applicable gates pass:

- Critical Playwright browser suite.
- Full Playwright role and tenant suite.
- API, package, migration, and integration tests.
- Guardian quality and functionality checks.
- Cross-tenant authorization and security suite.
- Billing, wallet, reservation, and ledger invariant suite.
- Windows and macOS native accuracy gates for every released agent artifact.
- Supported-tool and legitimate-application false-positive matrices.
- Load, spike, recovery, and soak baselines.
- Database migration rehearsal against a production-sized snapshot.
- Backup and restore drill.
- Queue, worker, webhook, and telemetry recovery drills.
- Alert, dashboard, and operational runbook validation.
- Canary deployment, synthetic interview, and rollback rehearsal.

No release should claim support for an operating system, cheating tool, or tool version that has not
passed the corresponding native signed accuracy gate.

## Playwright Project Structure

Use small, independent suites rather than one end-to-end file:

```text
tests/e2e/
  auth/
  onboarding/
  organizations/
  team/
  wallets/
  billing/
  integrations/
  interviews/
  candidate/
  live-monitoring/
  reports/
  founder/
  security/
  extension/
  fixtures/
  pages/
  helpers/
```

Every test must be parallel-safe and create or reserve its own records. Tests must not depend on the
execution order or state left by another test.

## Test Data and Provider Simulation

Do not create 100 organizations through the browser in every run. Provide a test-only seeding and
cleanup mechanism for:

- Organizations and verified users.
- Owner, Manager, and HR memberships.
- Subscriptions, enterprise agreements, wallets, allocations, and ledger entries.
- Calendar integrations, provider events, and webhook deliveries.
- Candidate tokens, enrolled devices, interviews, and monitoring sessions.
- Evidence events, reports, notifications, and operational failures.

Provider simulators should exist for:

- Email delivery.
- Google Calendar and OAuth callbacks.
- Dodo checkout and signed webhooks.
- Candidate native-agent enrollment and signed telemetry.
- Live-event transport.
- Object storage and report artifacts.

A small number of real-provider smoke tests should run after deployment. The deterministic simulator
suites should remain the primary CI signal.

## CI Execution Schedule

### Every Pull Request

- Guardian quality.
- Unit and migration tests.
- Critical authentication, onboarding, interview, consent, and report Playwright paths.
- Tenant-isolation smoke tests.

### Main Branch

- Complete Playwright application suite.
- Chrome extension suite.
- Billing and Calendar simulator suites.
- Production build.

### Nightly

- 100-organization and 1,000-interviewer tenant suite.
- Real Google and billing sandbox smoke tests.
- Windows and macOS detection matrices.
- Replay, ordering, recovery, and failure-injection tests.

### Weekly

- Load, spike, and soak tests.
- Backup and restore.
- Queue and worker recovery.
- Clean-application false-positive corpus.
- Capacity trend report.

### Before Every Production Release

- Full Phase 60 release gate.
- Signed native-agent accuracy evidence.
- Production-sized migration rehearsal.
- Canary synthetic interview and rollback verification.

## Definition of Success

The test program is successful only when all three statements are proven independently:

1. Playwright proves that Founder, Owner, Manager, HR, and candidate workflows operate correctly.
2. Load testing proves that more than 100 organizations and at least 1,000 interviewers can use the
   platform without tenant leakage, credit corruption, or unacceptable latency.
3. Native accuracy testing proves that released Windows and macOS agents detect supported cheating
   tools with the approved accuracy and false-positive thresholds.

Passing browser tests alone does not authorize a production cheating-detection claim.

## Phase 51–55 Implementation Status

The deterministic Chromium suite for Phases 51–55 is implemented under `tests/e2e/` and runs with:

```bash
npm run test:e2e
```

It currently covers protected-route redirects, the complete signup-verification-onboarding path,
safe return paths, Owner/Manager/HR permission boundaries, cross-tenant API escalation attempts, HR
wallet allocation and over-allocation, billing visibility, and independently owned Google Calendar
connections for every interviewer role. Invalid password-bound, expired, and reused verification
tokens are exercised through the real Nest API and PostgreSQL-compatible token store rather than a
browser-only mock.

The real API project provisions 100 organizations, 1,000 HR memberships, and 1,000 independent HR
sessions through production RPCs. It confirms each HR can see only itself, each Owner can see all 11
members in its own organization, and a foreign wallet member is indistinguishable from a missing
member. This is an isolation and correctness test, not a substitute for the Phase 59 latency and
capacity load test.

The calendar suite exercises ten HR connections in one organization. Its real API scenario sends
Owner, Manager, and HR sessions through the production Google connect and callback routes, token
encryption/storage, member-scoped summaries, disconnect route, and suspension cleanup. Only the
external Google HTTP responses are controlled and deterministic in CI.

The verified local baseline is 29 passing Playwright tests, 171 passing API tests, a successful
production build, and successful Guardian quality and functionality gates.

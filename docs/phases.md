# Authenti8 MVP — Feature-by-Feature Implementation Phases

## Platform Support Commitment

Authenti8 is planned to support both:

- Windows 10 and Windows 11
- macOS

The web application, backend, Google Calendar integration, recruiter Chrome extension, live Google Meet logs, telemetry pipeline, detection engine, dashboard, and reporting system will be shared across both platforms.

The candidate-side detector must be implemented separately for each operating system:

- Windows: Rust/C++ with Windows process, window, audio, service, and code-signing APIs
- macOS: Swift/AppKit with macOS running-application, window, Core Audio, code-signing, and permission APIs

The recommended implementation order is:

1. Build and validate the complete Windows detection pipeline.
2. Reuse the shared event schemas, telemetry backend, detection rules, recruiter panel, and reporting system.
3. Build the macOS detector using macOS-native APIs.
4. Run separate accuracy and false-positive testing for Windows and macOS.

The final product can support both platforms, but detection logic must be tested separately because Windows and macOS expose different system APIs and permissions.

---

## Locked Product Decisions

- Authenti8 supports Google Meet only in the MVP.
- The candidate receives and joins the original Google Meet URL.
- The recruiter never pastes or converts a meeting link manually.
- Every matching interview is protected automatically.
- The recruiter installs the Authenti8 Chrome extension once.
- The candidate installs Authenti8 Verify and gives explicit consent.
- Authenti8 focuses on detecting invisible real-time AI interview tools such as Cluely, Parakeet AI, and similar products.
- Authenti8 does not use eye tracking, facial expressions, nervousness, or speaking behavior.
- Live logs appear privately on the recruiter’s Google Meet screen.
- Every log and piece of evidence is stored in the Authenti8 dashboard.
- Final public results are:
  - Confirmed
  - Not Detected
- Monitoring coverage is shown separately.
- Phones and secondary computers are outside the MVP scope.

## Recommended Technology Architecture

```text
Web application:
Next.js + React + TypeScript

Backend:
NestJS + TypeScript

Database:
PostgreSQL

Real-time communication:
WebSockets

Queue and background jobs:
Redis + BullMQ

Recruiter extension:
Chrome Manifest V3

Windows verifier:
Rust with Windows APIs

macOS verifier:
Swift/AppKit with a shared Rust detection core where useful

File and evidence storage:
S3-compatible object storage

Infrastructure:
Docker + managed PostgreSQL + Redis
```

---

## One-Week Design-Partner Pilot

### Definition of MVP for This Week

The one-week MVP is a controlled, white-glove pilot for a small number of
founders and hiring teams. It is not a public launch, a generally available
enterprise product, or proof that Authenti8 can detect every form of cheating.

The purpose of the pilot is to prove one complete and trustworthy vertical
slice:

```text
Recruiter creates a protected interview
→ candidate receives a verification request
→ candidate understands the disclosure and consents
→ candidate device enrolls into the correct session
→ monitoring starts inside the authorized window
→ one validated supported tool can be identified while active
→ signed evidence reaches the backend
→ recruiter sees a private live result
→ monitoring coverage is calculated
→ an evidence-backed report is generated
```

The pilot must be honest about its supported operating system, tool versions,
permissions, and monitoring coverage. A narrow working product is more valuable
than a broad demonstration containing simulated detection.

### One-Week Pilot Scope

The initial controlled pilot supports:

- Google Meet only.
- Windows 11 as the first candidate operating system.
- One explicitly named and laboratory-validated cheating-tool family, limited
  to the versions that have actually passed the test matrix.
- One recruiter or hiring manager per pilot session.
- One candidate device per pilot session.
- Explicit candidate consent.
- Short-lived, single-session device enrollment.
- A signed Windows agent prototype with the minimum sensors required for the
  first supported detection pack.
- Identity confirmation plus proof that the tool is active during monitoring.
- Signed, ordered evidence events.
- A recruiter web live-session page as the guaranteed viewing surface.
- A final web report containing the result, coverage, interruptions, supported
  tool/version scope, and evidence summary.
- White-glove Authenti8 operator support before and during every pilot.

The first supported tool must be selected by technical feasibility testing, not
by marketing preference. Authenti8 must not advertise a tool until repeatable
detection and clean-corpus tests pass.

### Allowed Pilot Operating Exceptions

The long-term product remains automatic and calendar-driven. During the
one-week controlled pilot only, the Authenti8 team may perform operational work
manually when that work does not weaken consent, evidence integrity, or the
detection result.

Allowed temporary exceptions include:

- Operator-assisted interview registration instead of complete Calendar sync.
- Manual approval of a design-partner organization.
- Manual delivery or supervised delivery of the candidate verification link.
- Recruiter web live-session page instead of the Google Meet extension.
- Manual review of the generated report before it is released to the recruiter.
- Manual credit/account tracking with no self-service billing.

These are pilot shortcuts, not the promised final workflow. Detection must
never be mocked, manually assigned, or inferred by an operator.

### Explicitly Outside the One-Week Pilot

- macOS candidate monitoring.
- Windows 10 support.
- Candidate browser-only tool detection unless required by the selected first
  detection pack.
- Automatic protection of every matching Calendar event.
- Recruiter Chrome extension as a mandatory surface.
- Self-service subscriptions, invoices, and interview-credit purchasing.
- Teams, Zoom, and Webex.
- Multiple interviewers, multiple candidates, and group interviews.
- Mobile-device detection.
- Automatic candidate rejection or hiring recommendations.
- Production auto-update infrastructure.
- Multi-region infrastructure and the 100,000-session scale target.
- SAML, SCIM, data residency, and other enterprise controls.

### One-Week Build Sequence

```text
Day 1 — Product and detection contract
    Lock the supported tool/version and Windows 11 environment
    Lock CONFIRMED, NOT_DETECTED, and monitoring-state semantics
    Define consent text, event schema, threat model, and clean corpus
    Prove that the required Windows signals are accessible

Day 2 — Detection proof
    Build the smallest Windows sensor and local matcher
    Prove unique tool identity
    Prove active-use state separately
    Test installed-but-closed and renamed-process cases

Day 3 — Secure session path
    Create recruiter session, candidate activation, and consent flow
    Enroll one candidate device using a short-lived secret
    Sign, sequence, and ingest evidence and heartbeat events

Day 4 — Recruiter experience
    Build the live-session status page
    Stream validated monitoring and detection events
    Keep detection result separate from monitoring health

Day 5 — Completion and report
    Stop monitoring reliably
    Calculate coverage and interruptions
    Generate a reproducible final report from stored evidence

Day 6 — Adversarial and clean testing
    Run the supported-tool scenario matrix
    Run the legitimate-application corpus
    Test agent exit, network loss, replay, missing permission, and recovery

Day 7 — Pilot rehearsal and onboarding
    Run complete internal interviews
    Fix pilot-blocking failures
    Prepare candidate disclosure and recruiter instructions
    Onboard only the number of interviews the team can support live
```

### One-Week Pilot Release Gate

Do not place an external candidate into the pilot unless all of these pass:

- Consent is stored before monitoring begins.
- Monitoring automatically stops at the authorized end condition.
- The supported tool is repeatedly confirmed only while active.
- The same tool installed but closed is not confirmed.
- Process-name matching alone cannot confirm a result.
- The initial legitimate-application corpus produces zero confirmed incidents.
- Invalid, duplicated, replayed, or reordered evidence is rejected.
- Agent termination or missing permissions produces an interruption or
  unverified state, never a clean `NOT_DETECTED` state.
- The report can be reproduced from the stored signed evidence.
- The recruiter sees the tool/version and platform limitations.
- The candidate can decline without being labelled as cheating.
- A human Authenti8 operator has rehearsed the recovery procedure.

### How the Forty Phases Relate to the Pilot

The forty phases below describe the complete MVP and commercial foundation;
they are not all expected inside the one-week pilot.

```text
One-week pilot vertical slice:
    Minimal parts of Phases 1, 2, 4, 13, 15, 16, 18–19,
    23–25, 27–28, 30, 32–33, and 37–39

Post-pilot productization:
    Calendar automation, installer/updater hardening, recruiter extension,
    additional detection packs, notifications, and repeatable operations

Commercial B2B readiness:
    Billing, enterprise identity, policy controls, compliance evidence,
    support operations, scale hardening, and cross-platform coverage
```

---

# Phase 1 — Repository and System Foundation

## Feature

Create the complete Authenti8 development foundation.

## Implementation Algorithm

```text
1. Create one monorepo.
2. Add separate applications:
   - web
   - backend
   - recruiter-extension
   - candidate-extension
   - windows-agent
   - macos-agent
3. Add shared packages:
   - shared-types
   - detection-rules
   - validation
   - UI components
   - event schemas
4. Configure development, staging, and production environments.
5. Add automated formatting, linting, and type checking.
6. Add database migrations.
7. Add CI checks for every pull request.
8. Prevent deployment when tests or type checks fail.
```

## Suggested Structure

```text
authenti8/
├── apps/
│   ├── web/
│   ├── api/
│   ├── recruiter-extension/
│   ├── candidate-extension/
│   ├── windows-agent/
│   └── macos-agent/
├── packages/
│   ├── shared-types/
│   ├── event-schemas/
│   ├── detection-rules/
│   ├── security/
│   └── ui/
└── infrastructure/
```

## Completion Criteria

- All applications build independently.
- Shared schemas are consumed by the web, backend, extensions, and agents.
- Staging and production use different secrets and databases.
- No telemetry field is defined separately in multiple applications.

---

# Phase 2 — Database Architecture

## Feature

Create the database model that supports organizations, meetings, detection events, and reports.

## Core Tables

```text
users
organizations
organization_members
subscriptions
credit_transactions
google_integrations
calendar_sync_states
interviews
interview_participants
verification_sessions
candidate_devices
agent_heartbeats
telemetry_events
detection_rules
detection_incidents
reports
notifications
audit_logs
```

## Important Interview Fields

```text
id
organization_id
google_event_id
google_calendar_id
google_meet_code
google_meet_url
candidate_email
candidate_name
organizer_email
scheduled_start
scheduled_end
status
consent_status
monitoring_started_at
monitoring_ended_at
coverage_percentage
detection_result
report_id
```

## Algorithm

```text
WHEN Google event is received:
    FIND interview using organization_id + google_event_id

    IF interview exists:
        UPDATE mutable event fields
    ELSE:
        CREATE interview

    APPLY unique constraint:
        organization_id + google_calendar_id + google_event_id

WHEN telemetry arrives:
    STORE immutable telemetry event
    NEVER overwrite the original event
    CREATE derived detection incident separately
```

## Completion Criteria

- Duplicate Google events cannot create duplicate interviews.
- Telemetry records are append-only.
- Every event belongs to exactly one verification session.
- Organization-level data isolation is enforced.

---

# Phase 3 — Landing Page

## Feature

Build the Authenti8 public website.

## Sections

- Navigation
- Hero
- Product demonstration
- Problem
- How Authenti8 works
- Detection capabilities
- Privacy principles
- Pricing
- Frequently asked questions
- Footer

## Algorithm

```text
ON landing page load:
    Render public content
    Check whether the visitor has an active session

    IF logged in:
        Show "Open Dashboard"
    ELSE:
        Show "Start Protecting Interviews"

ON pricing plan selection:
    IF logged in:
        Redirect to checkout
    ELSE:
        Save selected plan temporarily
        Redirect to signup
```

## Main Product Message

> Authenti8 detects hidden real-time AI assistance during live Google Meet interviews and displays evidence-backed logs directly to the recruiter.

## Completion Criteria

- Responsive on desktop and mobile.
- Signup, login, and pricing buttons work.
- The website does not claim 100% detection.
- Google Meet is clearly identified as the MVP platform.

---

# Phase 4 — Authentication

## Feature

Implement signup, login, password recovery, and logout.

## Supported Authentication

- Continue with Google
- Work email and password
- Email verification
- Forgot password
- Logout
- Session revocation

## Algorithm

```text
SIGNUP:
    Validate email
    Normalize email
    Check existing account

    IF account exists:
        Return safe generic response

    Hash password
    Create user
    Send verification email

LOGIN:
    Validate credentials
    Check email verification
    Create secure session
    Store session in HTTP-only cookie

LOGOUT:
    Revoke current dashboard session
    Clear session cookie
    Do not disconnect Google Calendar
    Do not stop background interview protection
```

## Completion Criteria

- Protected routes cannot be opened without a valid session.
- Password-reset links expire.
- Logout does not stop calendar synchronization.
- Google login and Google Calendar authorization remain separate permissions.

---

# Phase 5 — Organization Onboarding

## Feature

Create the employer’s Authenti8 workspace.

## Required Fields

- Organization name
- Organization domain
- User’s role
- Company size
- Expected monthly interview volume
- Default time zone

## Algorithm

```text
AFTER first login:
    IF user has no organization:
        Start onboarding

    Create organization
    Add user as OWNER
    Create default strict interview policy
    Create zero-balance credit ledger
    Set Google integration status to DISCONNECTED
    Redirect to subscription selection
```

## Completion Criteria

- Every recruiter belongs to an organization.
- The first user becomes the owner.
- Strict detection policy is enabled automatically.
- Users from one organization cannot access another organization’s meetings.

---

# Phase 6 — Subscription and Interview Credits

## Implementation Status

Implemented in the application. Production activation requires migrations `010`
through `020`, Dodo test credentials, two Dodo product IDs, the verified webhook
endpoint `/api/v1/billing/webhooks/dodo`, and the Supabase billing-webhook worker.

## Feature

Allow recruiters to purchase a subscription and interview credits.

## MVP Plans

- Starter: free, 10 interviews per month, then $5 per extra interview.
- Professional: $1,000 per month, 300 interviews per month, then $5 per extra interview.
- Enterprise: contact sales; custom limits and invoice-link operations remain manual.

## Credit Rule

One credit is consumed only when candidate monitoring starts successfully.

## Algorithm

```text
WHEN payment succeeds:
    Verify payment-provider signature
    Activate subscription
    Add included credits
    Record immutable credit transaction

WHEN interview approaches:
    Check subscription status
    Check available credits

    IF subscription inactive:
        Mark interview UNPROTECTED_SUBSCRIPTION
    ELSE IF credits unavailable:
        Mark interview UNPROTECTED_NO_CREDITS
    ELSE:
        Reserve one credit

WHEN candidate monitoring starts:
    Convert reservation into consumed credit

WHEN interview is cancelled or candidate never verifies:
    Release reserved credit
```

## Completion Criteria

- Payment webhooks are idempotent.
- Repeated webhooks cannot add credits twice.
- Cancelled interviews do not consume credits.
- The dashboard always shows the ledger-calculated balance.

---

# Phase 7 — Dashboard Shell

## Implementation Status

Implemented with session and tenant checks, persistent workspace health warnings,
live credit visibility, and role-gated billing and integration operations.

## Feature

Create the authenticated dashboard layout.

## Navigation

1. Overview
2. Meetings
3. Plans and billing
4. Integrations
5. Logout

## Algorithm

```text
ON every dashboard request:
    Validate session
    Resolve organization
    Check user role
    Load subscription health
    Load Google integration health
    Load credit balance

    IF critical issue exists:
        Display persistent warning banner
```

## Warning Examples

- Google connection expired
- Subscription inactive
- No interview credits
- Calendar synchronization delayed
- Recruiter extension not detected

## Completion Criteria

- Navigation works.
- Active page is highlighted.
- Organization and credit information remain visible.
- Dashboard access follows role permissions.

---

# Phase 8 — Overview Tab

## Implementation Status

Implemented through one tenant-scoped aggregation RPC backed by the credit ledger,
interview state, reports, and Google integration state.

## Feature

Display the recruiter’s main usage summary.

## Dashboard Cards

- Links used
- Links remaining
- Upcoming protected interviews
- Completed interviews
- Confirmed detections
- Monitoring failures

## Algorithm

```text
ON overview load:
    Query current billing period
    Calculate credits consumed
    Calculate credits remaining
    Fetch upcoming protected interviews
    Fetch latest reports
    Fetch integration status

    Return one aggregated dashboard response
```

## Optimization

Use one backend aggregation endpoint rather than making the browser request every card separately.

## Completion Criteria

- Figures match the credit ledger.
- Upcoming interviews appear automatically.
- Recent reports link to the correct meeting.
- Data is restricted to the current organization.

---

# Phase 9 — Google OAuth and Connect Google Meet Tab

## Implementation Status

Implemented as a separate Calendar authorization flow with PKCE, encrypted tokens,
refresh handling, reauthorization state, disconnect, and Google push-channel setup.

## Feature

Connect the recruiter’s Google account.

## Algorithm

```text
1. Generate OAuth state and PKCE challenge.
2. Store state temporarily.
3. Redirect recruiter to Google authorization.
4. Validate returned state.
5. Exchange authorization code for tokens.
6. Encrypt refresh token.
7. Retrieve connected Google identity.
8. Save selected calendar.
9. Begin initial synchronization.
10. Register push-notification channel.
11. Mark integration ACTIVE.
```

## Completion Criteria

- Tokens are encrypted.
- Expired access tokens refresh automatically.
- Reauthorization works.
- Disconnecting Google stops new interview discovery but does not delete reports.

---

# Phase 10 — Initial Calendar Synchronization

## Implementation Status

Implemented with the 91-day scan window, pagination, recurring expansion,
cancellation handling, event-version checks, classification, and atomic upserts.

## Feature

Import future Google Meet interviews after the recruiter connects Google.

## Algorithm

```text
SET scan window:
    today - 1 day
    through today + 90 days

FETCH calendar events in pages

FOR each event:
    Validate event identifier
    Extract organizer
    Extract attendees
    Extract Meet URL and Meet code
    Normalize title
    Run interview-classification algorithm
    Upsert interview record

SAVE synchronization cursor or token
```

## Optimization

- Process events in batches.
- Use database upserts.
- Do not perform one database transaction per field.
- Store the Google event’s update timestamp.
- Ignore unchanged versions.

## Completion Criteria

- Existing upcoming interviews are imported.
- Duplicate events are prevented.
- Pagination works.
- Cancelled and recurring events are handled correctly.

---

# Phase 11 — Real-Time Calendar Updates

**Implementation status: Complete.** Authenticated webhook channels enqueue durable synchronization
jobs, stale integrations recover after 30 minutes, channels renew ahead of expiry, and lifecycle-aware
calendar updates handle creation, rescheduling, cancellation, and credit release.

## Feature

Automatically process newly scheduled, changed, or cancelled meetings.

## Algorithm

```text
WHEN Google webhook arrives:
    Validate channel identity
    Acknowledge immediately
    Add synchronization job to queue

BACKGROUND JOB:
    Load last synchronization state
    Fetch changed events
    For each changed event:
        Upsert event
        Reclassify interview
        Update meeting status
    Save new synchronization state
```

## Recovery Algorithm

```text
EVERY 30 minutes:
    Find integrations with stale sync times
    Run incremental recovery sync

EVERY 24 hours:
    Validate notification-channel expiry
    Renew channels before expiration
```

## Completion Criteria

- Newly created interviews appear without recruiter action.
- Rescheduled interviews update automatically.
- Cancelled events release reserved credits.
- Lost webhooks are recovered.

---

# Phase 12 — Automatic Interview Classification

**Implementation status: Complete.** The classifier is deterministic, covers the fixed MVP keyword
set, rejects ambiguous external attendees and resources, and stores a human-readable reason for every
matched interview.

## Feature

Identify which Google Calendar events are interviews.

## Fixed MVP Rules

A meeting is automatically protected when:

- It contains a Google Meet URL.
- The organizer belongs to the connected company.
- At least one attendee is outside the company domain.
- The title contains an interview-related term.

## Keywords

```text
interview
screening
candidate
technical round
coding round
HR round
founder round
manager round
culture round
final round
hiring
assessment
```

## Algorithm

```text
FUNCTION classifyEvent(event, organization):

    IF event.cancelled:
        RETURN NOT_INTERVIEW

    IF no Google Meet code:
        RETURN NOT_INTERVIEW

    externalAttendees =
        attendees excluding organization domains

    IF externalAttendees is empty:
        RETURN NOT_INTERVIEW

    titleScore = keywordMatch(event.title)
    descriptionScore = keywordMatch(event.description)
    attendeeScore = externalAttendees.count > 0

    IF titleScore is strong:
        RETURN INTERVIEW

    IF titleScore is medium AND attendeeScore:
        RETURN INTERVIEW

    IF titleScore is absent:
        RETURN NOT_INTERVIEW
```

## Important Rule

Do not use an AI classifier first. Start with deterministic rules so decisions are explainable and testable. Add ML classification only after collecting real customer examples.

## Completion Criteria

- Internal meetings are ignored.
- Matching interviews are protected automatically.
- Classification reasons are stored.
- No recruiter approval is required.

---

# Phase 13 — Interview Lifecycle Orchestrator

**Implementation status: Complete.** Database transition guards, immutable lifecycle events, leased
side-effect jobs, recovery transitions, and idempotency keys enforce the interview state machine.

## Feature

Manage every interview from discovery through final report.

## Status Flow

```text
DETECTED
→ PROTECTED
→ VERIFICATION_SCHEDULED
→ WAITING_FOR_CANDIDATE
→ CONSENT_PENDING
→ DEVICE_CONNECTING
→ MONITORING_ACTIVE
→ MEETING_COMPLETED
→ REPORT_PROCESSING
→ REPORT_READY
```

## Exception Statuses

```text
CANCELLED
CONSENT_DECLINED
NO_CREDITS
SUBSCRIPTION_INACTIVE
MONITORING_INTERRUPTED
UNABLE_TO_VERIFY
```

## Algorithm

```text
FOR every status transition:
    Validate allowed previous status
    Save transition timestamp
    Add immutable lifecycle event
    Run required side effect through queue
    Never run side effect directly inside DB transaction
```

## Completion Criteria

- Invalid status transitions are rejected.
- Every transition is auditable.
- Retried background jobs do not duplicate emails, credits, or reports.

---

# Phase 14 — Candidate Verification Delivery

**Implementation status: Complete.** A protected cron endpoint schedules delivery at T-1 minute,
revalidates subscription and credits, creates hash-only short-lived tokens, uses the durable encrypted
mail outbox, retries failures, and surfaces terminal delivery alerts to the recruiter dashboard.

## Feature

Deliver the Authenti8 Verify setup without changing the Google Meet URL.

Because the candidate receives the original Meet URL, Authenti8 needs a separate automatic method to start device verification.

## Recommended MVP Flow

At the scheduled interview start time, Authenti8 automatically sends the candidate a verification email.

The recruiter takes no action.

## Algorithm

```text
AT scheduled_start - 1 minute:
    Confirm interview still active
    Confirm subscription and credit reservation
    Create short-lived candidate verification token
    Bind token to:
        interview_id
        candidate_email
        expiration time
        one-time-use identifier

    Send:
        "Complete Authenti8 Verification"

IF email fails:
    Retry using queue
    Notify recruiter panel
```

## Completion Criteria

- Candidate receives the verification request automatically.
- The token expires after the interview window.
- Tokens cannot be reused for another interview.
- The recruiter does not manually send anything.

---

# Phase 15 — Candidate Consent Portal

**Implementation status: Complete.** The public token-bound portal explains collection scope, records
versioned acceptance or decline, creates a verification session only after acceptance, releases the
credit on decline, and never labels a decline as cheating.

## Feature

Obtain explicit candidate consent before device monitoring.

## Algorithm

```text
WHEN candidate opens verification URL:
    Validate token
    Validate interview time window
    Confirm token has not been consumed
    Display organization and interview details
    Display data-collection explanation

IF candidate accepts:
    Store:
        consent version
        timestamp
        candidate identity
    Mark CONSENT_ACCEPTED
    Create verification session
    Continue to device setup

IF candidate declines:
    Mark CONSENT_DECLINED
    Do not start agent monitoring
    Notify recruiter panel
```

## Consent Must Explain

- Running applications and windows may be checked.
- Hidden overlays may be checked.
- Browser extensions may be checked.
- Audio-device configuration may be checked.
- Personal files and messages are not collected.
- Monitoring stops after the interview.

## Completion Criteria

- No telemetry is accepted before consent.
- Consent version is stored.
- Candidate can decline.
- Declining is never labelled as cheating.

---

# Phase 16 — Candidate Device Enrollment

**Implementation status: Complete.** Consent now creates a hash-only, expiring enrollment secret;
the agent proves possession of a new ephemeral Ed25519 key against a server challenge, one active
device is enforced per session, and signed ordered telemetry is rejected unless that device enrolled.

## Feature

Securely connect Authenti8 Verify to the correct interview.

## Algorithm

```text
AFTER consent:
    Backend generates:
        verification_session_id
        one-time enrollment secret
        server challenge
        expiration timestamp

Candidate app opens using custom protocol:
    authenti8://verify?token=...

Agent:
    Validate server certificate
    Exchange enrollment secret
    Generate ephemeral device key pair
    Send public key and system information
    Sign server challenge

Backend:
    Verify challenge signature
    Bind public key to verification session
    Invalidate enrollment secret
```

## Completion Criteria

- A copied enrollment URL cannot create unlimited devices.
- One session has one active primary candidate device.
- Events from an unenrolled agent are rejected.
- Enrollment secrets are short-lived and single-use.

---

# Phase 17 — Authenti8 Verify Installer and Updater

**Implementation status: Repository implementation complete; Windows release ceremony pending.**
The Windows package enforces Authenticode at installation, registers the custom protocol and native
host, supports uninstall, and verifies Ed25519 update manifests and package hashes. A distributable
installer still requires the external Authenticode certificate and a Windows release build.

## Feature

Create the candidate application installer.

## Candidate Experience

```text
Download Authenti8 Verify
→ Open
→ Approve operating-system prompt
→ Verification begins
```

## Algorithm

```text
INSTALLER:
    Verify supported operating system
    Install signed Authenti8 binary
    Register custom authenti8:// protocol
    Register browser native-messaging host
    Register uninstaller
    Start Authenti8 Verify

ON application start:
    Verify own code signature
    Check minimum supported version
    Check signed update manifest
    Update only from verified Authenti8 source
```

## Platform Packaging

### Windows

- Signed `.exe` or `.msi` installer
- Windows code-signing certificate
- Optional background service
- Standard-user mode wherever possible
- Administrator access only for capabilities that truly need it

### macOS

- Signed and notarized `.pkg` or `.dmg`
- Apple Developer ID signing
- Required Privacy & Security permissions
- Launch helper where required
- No kernel extension for the first version

## Completion Criteria

- Installer is code-signed.
- Automatic updates are cryptographically verified.
- Candidate can uninstall the application.
- Monitoring is not always active; it activates only for an authorized session.

---

# Phase 18 — Windows Process Detection

**Implementation status: Implemented for the Windows 11 pilot agent; laboratory validation pending.**
The local collector reconciles processes, caches executable identity by path/size/modification time,
and treats names as low confidence. No prohibited-tool rule is enabled until Phase 28 validation.

## Feature

Detect known prohibited applications and background AI processes on Windows.

## Collection Algorithm

```text
ON monitoring start:
    Capture baseline process snapshot

WHILE monitoring:
    Subscribe to process start/stop events where practical
    Every 3 seconds run reconciliation scan

FOR each process:
    Collect:
        process ID
        executable name
        normalized executable path hash
        SHA-256 file hash
        signer certificate
        file version
        parent process ID
        process start time

    Compare against signature database
    Emit only:
        process started
        process stopped
        signature matched
        identity changed
```

## Detection Algorithm

```text
IF exact prohibited executable hash matches:
    Emit HIGH_CONFIDENCE_MATCH

ELSE IF trusted prohibited publisher + known product metadata match:
    Emit HIGH_CONFIDENCE_MATCH

ELSE IF only process name matches:
    Emit LOW_CONFIDENCE_SIGNAL
    Do not confirm cheating
```

## Optimization

- Cache file hashes using file path, size, and modification time.
- Do not hash the same unchanged executable every three seconds.
- Send changes rather than full process lists.
- Keep the complete list locally unless an event requires evidence.

## Completion Criteria

- Detect supported known processes.
- Renaming the executable alone does not bypass hash or signer checks.
- Ordinary applications do not create confirmed incidents.
- CPU usage remains low during a one-hour interview.

---

# Phase 19 — Windows Invisible Overlay Detection

**Implementation status: Implemented for the Windows 11 pilot agent; clean-corpus validation pending.**
The Win32 sensor captures ownership, visibility, bounds, extended styles, and display affinity without
screenshots; overlay evidence can become high confidence only with authoritative process identity.

## Feature

Detect transparent, always-on-top, and capture-excluded windows.

## Algorithm

```text
EVERY 1–2 seconds:
    Enumerate top-level windows

FOR each window:
    Collect:
        window handle
        owner process ID
        visibility
        rectangle
        z-order category
        extended styles
        layered/transparent status
        topmost status
        capture-affinity status
        window title hash
        window class hash

    Join window with process identity

    IF window appears or important properties change:
        Emit window event
```

## Confirmation Logic

```text
IF known prohibited process owns:
       transparent window
    OR always-on-top overlay
    OR capture-excluded window:
        Confirm prohibited assistance

IF unknown process owns suspicious overlay:
    Store internal suspicious signal
    Do not publicly mark Confirmed without additional evidence
```

## Completion Criteria

- Visible and capture-excluded windows are distinguished.
- Overlay evidence is linked to its owning process.
- Legitimate overlays such as volume controls do not trigger confirmed cheating.
- Window enumeration does not depend on screenshots.

---

# Phase 20 — Windows Audio-Route Detection

**Implementation status: Implemented for the Windows 11 pilot agent; device-matrix validation pending.**
The Core Audio sensor baselines capture/render endpoints, communications defaults, state, names, and
providers; a virtual device never confirms a result without authoritative process and active-use proof.

## Feature

Detect virtual microphones, virtual speakers, and audio-route changes associated with cheating tools.

## Algorithm

```text
ON monitoring start:
    Enumerate capture and render endpoints
    Record default communications endpoints
    Mark known physical and virtual devices

SUBSCRIBE to audio endpoint changes

WHEN endpoint is added, removed, or becomes default:
    Record device identifier hash
    Record friendly name
    Record driver/provider identity
    Record direction: input/output
    Compare with virtual-audio signature database
```

## Decision Rule

```text
Virtual audio device alone:
    Do not confirm

Known prohibited AI process
    + associated virtual audio route
    + activity during interview:
        Confirm

Unknown virtual device without supporting evidence:
    Record informational event only
```

## Completion Criteria

- Existing audio devices form a baseline.
- Changes during the interview are logged.
- Common legitimate devices do not cause confirmed results.
- Evidence shows why an audio event contributed to a detection.

---

# Phase 21 — Candidate Chrome Extension

## Implementation Status

Implemented as a Manifest V3 candidate extension with local ID matching,
managed signature configuration, active-profile instance identity, periodic
health reporting, and privacy-filtered Chrome native messaging. The Windows
native host spools only matched-extension and profile-health evidence for the
enrolled verifier; full extension inventories, names, and permissions are not
sent to the backend or recruiter.

## Feature

Detect prohibited browser extensions and communicate with Authenti8 Verify.

## Algorithm

```text
AFTER consent and extension approval:
    Query installed extensions

FOR each extension:
    Collect:
        extension ID
        name
        version
        enabled state
        installation type
        declared permissions

    Compare extension ID with signature database

Send only:
    matched prohibited extension
    extension enabled/disabled event
    Authenti8 extension health
```

## Native Connection

```text
Candidate extension
    ↔ Chrome native messaging
    ↔ Authenti8 Verify
```

## Completion Criteria

- Known prohibited extension IDs are detected.
- Only the active Chrome profile is claimed as verified.
- Authenti8 reports when the candidate uses an unverified browser.
- Full extension lists are not exposed to recruiters.

---

# Phase 22 — macOS Candidate Agent

## Implementation Status

Implemented with macOS enrollment, Keychain-protected Ed25519 identity,
normalized signed telemetry, permission-state reporting, and a native
Swift/AppKit/CoreGraphics/Core Audio sensor. The release script fails closed
unless an Apple signing identity and notarytool profile are supplied. Producing
the distributable signed/notarized artifact therefore requires the production
Apple credentials and macOS release runner.

## Feature

Implement macOS process, overlay, browser, and audio verification.

## Process and Application Algorithm

```text
ON monitoring start:
    Enumerate running applications
    Capture:
        bundle identifier
        process ID
        executable URL hash
        code-signing identity
        application version
        launch time

SUBSCRIBE to:
    application launch events
    application termination events
    frontmost application changes

FOR each application:
    Compare bundle ID, signer identity, hash, and metadata
    with the prohibited-tool signature database
```

## macOS Window and Overlay Algorithm

```text
ENUMERATE visible and layered windows where permitted

FOR each window:
    Collect:
        owning process ID
        owner bundle identifier
        window layer
        bounds
        alpha/transparency
        on-screen state
        title hash

    IF known prohibited application owns:
        transparent overlay
        floating panel
        top-level assistance window
    THEN:
        Create high-confidence signal
```

## macOS Audio Algorithm

```text
ON monitoring start:
    Enumerate Core Audio devices
    Record default input and output
    Identify aggregate and virtual devices

SUBSCRIBE to device changes

WHEN device changes:
    Compare driver/provider and device metadata
    with known virtual-audio signatures
```

## macOS Permissions

Depending on the exact implementation, Authenti8 may require:

- Accessibility permission
- Screen and System Audio Recording permission only if genuinely needed
- Microphone permission only if genuinely needed
- Background operation permission

The product should request the minimum necessary permissions.

## Distribution Algorithm

```text
Build signed application
Submit for Apple notarization
Staple notarization result
Verify signature before every update
Ship signed and notarized package
```

## Completion Criteria

- Signed and notarized package installs successfully.
- Known bundle identifiers and signer identities are detected.
- Monitoring starts only after consent.
- Unsupported permission states are reported as incomplete coverage.
- macOS results use the same backend event schema as Windows.

---

# Phase 23 — Cross-Platform Detection Abstraction

## Implementation Status

Implemented in the shared event-schema package. Windows, macOS, and Chrome use
the same normalized evidence vocabulary while retaining platform-specific
payload fields for internal rule evaluation. Recruiter-facing state is derived
from validated normalized events rather than raw operating-system APIs.

## Feature

Ensure Windows and macOS produce the same normalized evidence types.

## Shared Event Types

```text
PROCESS_STARTED
PROCESS_STOPPED
KNOWN_PROCESS_MATCH
WINDOW_CREATED
WINDOW_CHANGED
HIDDEN_OVERLAY_MATCH
CAPTURE_EXCLUDED_WINDOW
BROWSER_EXTENSION_MATCH
AUDIO_DEVICE_ADDED
AUDIO_ROUTE_CHANGED
AGENT_HEARTBEAT
AGENT_TAMPERED
MONITORING_INTERRUPTED
```

## Algorithm

```text
WINDOWS AGENT:
    Convert Windows-native events into shared Authenti8 events

MACOS AGENT:
    Convert macOS-native events into the same shared Authenti8 events

BACKEND:
    Evaluate shared events using platform-aware detection rules

RULE:
    Never let platform-specific raw API data directly reach recruiter UI
```

## Completion Criteria

- Reports look consistent on Windows and macOS.
- Platform-specific evidence remains available internally.
- Shared detection logic can be reused.
- Platform-specific rule conditions remain supported.

---

# Phase 24 — Secure Telemetry Pipeline

## Implementation Status

Implemented with Ed25519 enrollment, canonical payload hashes, ordered event
hash chains, immutable database ingestion, device/platform binding, timestamp
windows, idempotent replay recovery, and encrypted-at-rest platform credential
stores. Windows and macOS retain ordered offline queues and retry with bounded
exponential backoff; the backend rejects modification, duplication, replay,
chain gaps, and out-of-window evidence.

## Feature

Send candidate-device evidence securely to the Authenti8 backend.

## Event Schema

```text
event_id
verification_session_id
sequence_number
event_type
event_timestamp
monotonic_timestamp
platform
payload
payload_hash
previous_event_hash
agent_version
rule_pack_version
signature
```

## Algorithm

```text
AGENT:
    Increment sequence number
    Hash normalized payload
    Include previous event hash
    Sign complete event using session private key
    Send through TLS

BACKEND:
    Validate session
    Validate signature
    Validate sequence number
    Validate timestamp tolerance
    Validate previous-event hash
    Reject duplicate or replayed event
    Save immutable event
```

## Offline Handling

```text
IF connection lost:
    Encrypt events locally
    Preserve sequence
    Retry with exponential backoff

WHEN connection restores:
    Upload missing events in order
```

## Completion Criteria

- Modified events fail signature validation.
- Replayed events are rejected.
- Short network interruptions do not lose evidence.
- Recruiter logs are generated only from validated events.

---

# Phase 25 — Monitoring Session Orchestrator

## Implementation Status

Implemented with five-second agent heartbeats, ten-second interruption
detection, idempotent recovery, candidate/recruiter/authorized-window stop
paths, recruiter workspace notifications, and coverage calculated separately
from detection results. Migration `035_monitoring_orchestrator.sql` adds the
durable interruption ledger and fail-closed monitoring health state.

## Feature

Start and stop monitoring at the correct time.

## Algorithm

```text
START CONDITIONS:
    consent accepted
    device enrolled
    agent connected
    supported version
    interview is inside allowed time window

IF all conditions pass:
    Mark MONITORING_ACTIVE
    Start coverage timer
    Send recruiter log

EVERY 5 seconds:
    Expect agent heartbeat

IF heartbeat missing for 10 seconds:
    Mark temporary interruption
    Notify recruiter panel

IF heartbeat returns:
    Close interruption interval
    Resume coverage

STOP CONDITIONS:
    Meet conference ended
    candidate explicitly ends verification
    scheduled end + grace period reached
    recruiter ends interview
```

## Coverage Calculation

```text
eligible_duration =
    monitoring_end - monitoring_start

verified_duration =
    eligible_duration - interruption_duration

coverage_percentage =
    verified_duration / eligible_duration × 100
```

## Completion Criteria

- Monitoring never begins before consent.
- Temporary interruptions are measured accurately.
- Meeting end automatically stops collection.
- Monitoring coverage is independent of cheating result.

---

# Phase 26 — Detection Signature Database

## Implementation Status

Implemented with migration `036_detection_and_live_logs.sql`: immutable rule versions,
two-person approval enforcement, signed per-platform packs, immediate disablement, and retained
superseded packs for rollback. Agents accept only signed, unexpired packs and attach pack versions
to every telemetry envelope.

## Feature

Maintain technical signatures for supported cheating tools.

## Signature Types

- Executable hashes
- Publisher certificates
- Product names
- File-version metadata
- Bundle identifiers
- Browser-extension IDs
- Window classes
- Window behavior
- Service identifiers
- Audio-driver identifiers
- Known installation paths as supporting evidence

## Algorithm

```text
Detection rule contains:
    rule_id
    product_family
    platform
    signal_type
    match_condition
    confidence
    required_supporting_signals
    version
    enabled
    created_by
    reviewed_by
```

## Rule Deployment

```text
1. Create draft rule.
2. Test against malicious/tool sample suite.
3. Test against legitimate application suite.
4. Require reviewer approval.
5. Publish signed rule pack.
6. Agents download signed rule pack.
7. Retain previous rule-pack version for rollback.
```

## Completion Criteria

- Rules are versioned.
- A bad rule can be disabled immediately.
- Every detection report includes the rule version.
- Unapproved rules cannot reach production.

---

# Phase 27 — Detection Decision Engine

## Implementation Status

Implemented as a server-authoritative decision path. High-confidence technical identities and
complete medium-confidence combinations can create immutable confirmed incidents; low-confidence
behavior, missed heartbeats, and incomplete evidence are retained without changing the verdict.

## Feature

Convert telemetry into Confirmed or Not Detected.

## Internal Confidence Model

```text
HIGH:
    Exact known binary hash
    Known signed application identity
    Known browser-extension ID
    Known prohibited bundle ID
    Known process owning a prohibited hidden overlay

MEDIUM:
    Suspicious overlay behavior
    Known virtual audio route
    Similar process metadata
    Unknown process using unusual window behavior

LOW:
    Process-name match only
    Generic AI-related title
    Tab switching
    Second monitor
```

## Algorithm

```text
FOR each validated event:
    Run matching rules

IF any HIGH rule is satisfied:
    Create confirmed incident

ELSE IF required combination of MEDIUM rules is satisfied:
    Create confirmed incident

ELSE:
    Keep signals for internal analysis
    Do not expose them as cheating
```

## Final Verdict

```text
IF confirmed_incidents.count > 0:
    detection_result = CONFIRMED
ELSE:
    detection_result = NOT_DETECTED
```

## Monitoring Status

```text
FULLY_VERIFIED
PARTIALLY_VERIFIED
UNABLE_TO_VERIFY
```

## Completion Criteria

- Behavioral signals never confirm cheating.
- Every confirmed incident has technical evidence.
- A missing heartbeat does not automatically mean cheating.
- Recruiters cannot manually change the technical verdict.

---

# Phase 28 — Known Cheating-Tool Test Pack

## Implementation Status

Implemented with repeatable cross-platform scenario fixtures for Cluely and Parakeet AI covering
idle, active, minimized, overlay, capture-excluded, renamed, updated, and start-order scenarios.
Stable signer/bundle identities ensure renaming is not the only detection boundary; unsupported
versions remain outside published packs until compatibility tests pass.

## Feature

Develop and validate detection for Cluely, Parakeet AI, and other supported tools.

## Algorithm

```text
FOR each target tool:
    Install in isolated Windows and macOS test environments
    Record:
        executable identities
        signer identities
        bundle identifiers
        browser extensions
        helper processes
        service names
        window properties
        overlay behavior
        audio-device behavior
        update behavior

Run scenarios:
    tool idle
    tool active
    tool minimized
    overlay visible
    overlay capture-excluded
    executable renamed
    tool updated
    Authenti8 started before tool
    tool started after interview begins

Create signatures only from repeatable signals.
```

## Important Rule

Never create a detection signature from a single test run.

## Completion Criteria

- Each supported tool has repeatable Windows and macOS tests where applicable.
- Renaming the process does not defeat all detections.
- New tool versions trigger compatibility testing.
- Unsupported versions are not advertised as detected.

---

# Phase 29 — Recruiter Chrome Extension

## Implementation Status

Implemented with strict Meet-code parsing, short-lived recruiter/workspace-bound tokens,
server-side protected-interview authorization, refresh-safe cursors, and a production MV3 manifest.
The extension remains invisible for unprotected or unauthorized meetings.

## Feature

Recognize protected Google Meet interviews and display Authenti8 data.

## Algorithm

```text
WHEN recruiter opens meet.google.com:
    Parse Meet code from URL
    Authenticate recruiter extension
    Query backend for protected interview

IF protected interview exists:
    Connect WebSocket
    Load latest event sequence
    Render Authenti8 panel
ELSE:
    Do not render panel
```

## Security

```text
Extension token:
    short-lived
    organization-bound
    recruiter-bound
    stored using Chrome storage
    refreshed through dashboard session
```

## Completion Criteria

- Panel appears only for protected interviews.
- Candidate does not need the recruiter extension.
- An unauthorized user cannot subscribe to meeting logs.
- Extension reconnects after page refresh.

---

# Phase 30 — Live Google Meet Logs Panel

## Implementation Status

Implemented with a closed Shadow DOM, draggable/collapsible panel, resumable server-sent live-log
transport, duplicate suppression, chronological ordering, reconnecting state, and persisted cursors.
Only backend-created recruiter events render; the panel never evaluates technical evidence locally.

## Feature

Display live logs in the recruiter’s Google Meet screen.

## UI States

```text
Waiting for candidate
Consent pending
Device connecting
Monitoring active
Confirmed detection
Monitoring interrupted
Meeting completed
```

## Rendering Algorithm

```text
Create fixed-position container
Attach closed Shadow DOM
Render panel inside Shadow DOM
Avoid depending on Google Meet internal CSS classes

ON WebSocket event:
    Validate sequence number
    Ignore duplicates
    Insert event chronologically
    Update status header
    Persist latest sequence cursor

IF disconnected:
    Show reconnecting state
    Fetch missing logs after reconnection
```

## Panel Example

```text
AUTHENTI8                         ● ACTIVE

Rahul Panchal
Platform: Windows 11
Monitoring coverage: 100%

5:02:41  Verification request opened
5:02:46  Consent accepted
5:02:50  Candidate device verified
5:02:51  Monitoring started
5:18:34  Prohibited AI overlay confirmed
```

## Completion Criteria

- Logs appear within seconds.
- The panel is draggable and collapsible.
- Refreshing Google Meet restores previous logs.
- Every displayed event already exists in the backend.
- The panel never creates a cheating result locally.

---

# Phase 31 — Meetings Tab

## Feature

Display automatically protected interviews and their results.

## Filters

- Upcoming
- Live
- Completed
- Confirmed
- Not Detected
- Unable to Verify
- Cancelled

## Algorithm

```text
QUERY parameters:
    status
    date range
    interviewer
    candidate search
    page cursor

BACKEND:
    Validate organization
    Apply indexed filters
    Return cursor-paginated results
    Include only summary fields

WHEN row opened:
    Fetch full meeting timeline and report
```

## Completion Criteria

- Recruiters cannot manually create or sanitize meetings.
- Live meetings update automatically.
- Pagination remains fast with large histories.
- Candidate search is organization-scoped.

---

# Phase 32 — Immutable Logs and Evidence Storage

## Feature

Store all interview events securely.

## Storage Categories

### Recruiter-Readable Logs

```text
Candidate consent accepted
Device verification active
Monitoring interrupted
Prohibited AI assistance confirmed
```

### Restricted Technical Evidence

```text
Executable hash
Signer identity
Bundle ID
Window properties
Rule ID
Agent signature
Raw event metadata
```

## Algorithm

```text
ON validated telemetry:
    Save raw event
    Run detection engine
    Create recruiter-readable event
    Push readable event to WebSocket
    Preserve technical evidence separately

NEVER:
    Allow recruiter to edit raw evidence
    Delete one event without applying retention policy
```

## Completion Criteria

- Logs survive browser refreshes.
- Technical evidence is permission-restricted.
- Every recruiter log points to its source event.
- Evidence integrity can be verified later.

---

# Phase 33 — Final Integrity Report

## Feature

Generate the report automatically after the interview.

## Report Structure

- Candidate
- Interview title
- Interviewer
- Date and duration
- Consent
- Device and operating system
- Detection result
- Monitoring coverage
- Monitoring interruptions
- Confirmed incidents
- Evidence timeline
- Authenti8 rule-pack version
- Disclaimer

## Algorithm

```text
WHEN monitoring ends:
    Lock session for processing
    Wait briefly for delayed offline events
    Recalculate coverage
    Run final detection evaluation
    Generate report snapshot
    Store report version
    Mark REPORT_READY
    Notify recruiter
```

## Result Examples

```text
Detection: Confirmed
Platform: macOS
Coverage: 99%
Incident: Prohibited invisible AI overlay
Evidence events: 3
```

```text
Detection: Not Detected
Platform: Windows 11
Coverage: 100%
Monitoring interruptions: None
```

## Completion Criteria

- Report is reproducible from stored evidence.
- Reports cannot silently change when rules are later updated.
- Downloaded PDF matches the web report.
- Not Detected is not described as proof that cheating was impossible.

---

# Phase 34 — Buy Extra Links Tab

## Feature

Allow the organization to purchase additional interview credits.

## Algorithm

```text
Display:
    current plan
    used credits
    available credits
    renewal date
    transaction history

WHEN package selected:
    Create payment order
    Complete checkout
    Verify payment webhook
    Add credit ledger entry
    Refresh dashboard balance
```

## Completion Criteria

- Credits are never added from browser confirmation alone.
- Payment webhook verification is mandatory.
- Refunds create reverse ledger entries.
- Users can download invoices.

---

# Phase 35 — Notifications

## Feature

Send meaningful notifications without creating noise.

## Notify Recruiter When

- Google authorization expires
- Subscription payment fails
- Credits are low
- Candidate declines consent
- Candidate verification cannot start
- Monitoring is interrupted
- Prohibited assistance is confirmed
- Report is ready

## Algorithm

```text
WHEN notification event occurs:
    Generate deterministic deduplication key

IF key already sent:
    Do not send again

ELSE:
    Save dashboard notification
    Send email when severity requires it
```

## Completion Criteria

- Duplicate alerts are prevented.
- Notification links open the correct interview.
- Normal heartbeats do not create notifications.
- Confirmed incidents are delivered immediately.

---

# Phase 36 — Internal Admin Panel

## Feature

Allow the Authenti8 team to operate the platform.

## Admin Capabilities

- Search organizations
- Review subscription state
- Review calendar-sync failures
- Review agent connectivity
- Review detection evidence
- Manage signature packs
- Disable unreliable rules
- Refund credits
- View application versions
- Review candidate disputes

## Algorithm

```text
FOR every admin action:
    Require administrator role
    Require action reason for sensitive changes
    Save immutable audit entry
    Store previous and new value
```

## Completion Criteria

- Admins cannot modify raw telemetry.
- Rule changes require approval.
- Every admin action is auditable.
- Customer data access is logged.

---

# Phase 37 — Privacy, Security, and Retention

## Feature

Protect candidate and recruiter information.

## Rules

- No monitoring before consent.
- Stop collection after the interview.
- Do not collect personal files or messages.
- Do not expose full process lists to recruiters.
- Encrypt OAuth tokens and sensitive evidence.
- Use organization-level access control.
- Automatically delete data according to retention settings.

## Retention Algorithm

```text
DAILY:
    Find expired interviews
    Delete or anonymize candidate identifiers
    Delete raw evidence according to policy
    Preserve required billing and audit information separately
    Record deletion audit event
```

## Completion Criteria

- Candidate data has a defined deletion date.
- Reports cannot be accessed after deletion.
- Secrets are never stored in logs.
- Tenant-isolation tests pass.

---

# Phase 38 — Accuracy and False-Positive Test Harness

## Feature

Prove that Authenti8 detects supported tools without falsely accusing legitimate candidates.

## Test Suites

### Prohibited Tool Suite

- Cluely
- Parakeet AI
- Supported browser extensions
- Hidden overlay test application
- Capture-excluded overlay test application
- Virtual audio plus AI assistant test

### Legitimate Application Suite

- Google Meet
- Slack
- Microsoft Teams
- Zoom
- Notion
- VS Code
- Screen recorders
- Password managers
- Accessibility software
- Noise-removal tools
- Common virtual-audio tools

## Algorithm

```text
FOR each Windows agent build:
    Run prohibited-tool scenarios
    Run legitimate-tool scenarios

FOR each macOS agent build:
    Run prohibited-tool scenarios
    Run legitimate-tool scenarios

Calculate per platform:
    true positives
    false positives
    missed detections
    coverage failures

BLOCK release when:
    supported prohibited tool is repeatedly missed
    any benign application creates a high-confidence confirmed result
    telemetry integrity tests fail
```

## Recommended Release Philosophy

Prioritize precision over aggressive detection. It is better to report Not Detected than incorrectly mark an innocent candidate as Confirmed.

## Completion Criteria

- Every advertised tool has an automated detection test.
- Benign application tests produce no confirmed incidents.
- Results are versioned by operating system, agent, and rule pack.

---

# Phase 39 — Observability and Failure Recovery

## Feature

Monitor all production components.

## Track

- Calendar webhook failures
- OAuth refresh failures
- Queue delays
- WebSocket connection failures
- Agent enrollment errors
- Telemetry rejection rates
- Report-generation failures
- Detection-rule errors
- Extension versions
- Windows agent crash rates
- macOS agent crash rates

## Algorithm

```text
FOR every background job:
    Assign correlation ID
    Use idempotency key
    Retry with exponential backoff
    Move repeatedly failing jobs to dead-letter queue
    Alert engineering after threshold
```

## Completion Criteria

- Failed reports can be safely regenerated.
- Missed calendar updates are recoverable.
- Every interview can be traced using one correlation ID.
- System failures do not silently produce Not Detected.

---

# Phase 40 — End-to-End Pilot Release

## Feature

Run the complete Authenti8 workflow with selected design partners.

## Pilot Algorithm

```text
1. Recruiter subscribes.
2. Recruiter connects Google.
3. Recruiter installs extension once.
4. Recruiter schedules normal Google Meet interview.
5. Authenti8 automatically recognizes the event.
6. Candidate receives original Google Meet URL.
7. Candidate receives automatic verification request.
8. Candidate accepts consent.
9. Candidate installs or opens Authenti8 Verify.
10. Windows or macOS monitoring begins.
11. Candidate joins Google Meet.
12. Recruiter panel shows live logs.
13. Hidden-tool detection runs.
14. Logs are saved.
15. Meeting ends.
16. Report is generated automatically.
17. Recruiter reviews result.
```

## Pilot Release Gate

Do not launch publicly until:

- Calendar automation works without recruiter intervention.
- Live logs restore correctly after refresh.
- Supported cheating tools are detected repeatedly in controlled tests.
- Legitimate applications do not produce confirmed results.
- Monitoring interruptions are clearly separated from cheating.
- Candidate consent is recorded before telemetry.
- Reports can be regenerated from immutable evidence.
- Windows and macOS have separate accuracy reports.
- Unsupported platform or permission states never silently appear as Fully Verified.

---

# Final MVP Detection Algorithm

```text
BEGIN INTERVIEW VERIFICATION

Validate candidate consent
Enroll Authenti8 Verify
Identify operating system

IF platform is Windows:
    Start Windows detector

ELSE IF platform is macOS:
    Validate required permissions
    Start macOS detector

ELSE:
    Mark platform unsupported
    Stop verification

Capture baseline:
    processes or applications
    windows
    browser extensions
    audio endpoints

START monitoring

LOOP until interview ends:

    Receive process/application events
    Receive window and overlay events
    Receive browser-extension events
    Receive audio-device events
    Receive agent heartbeat

    Validate event signature
    Reject replayed or invalid events
    Store event immutably

    Match event against:
        common cross-platform rules
        platform-specific rules

    IF exact prohibited technical identity found:
        Create CONFIRMED incident

    ELSE IF approved combination of technical signals found:
        Create CONFIRMED incident

    ELSE:
        Continue monitoring

    Push readable logs to recruiter extension

END LOOP

Calculate monitoring coverage

IF one or more confirmed incidents:
    Result = CONFIRMED
ELSE:
    Result = NOT_DETECTED

Generate final report
Store evidence
Notify recruiter

END INTERVIEW VERIFICATION
```

---

# Recommended Implementation Sequence

```text
Foundation and database
→ Authentication and billing
→ Google Calendar automation
→ Meeting lifecycle
→ Candidate consent and enrollment
→ Shared telemetry and event schemas
→ Windows detection agent
→ Detection engine
→ Recruiter extension and live panel
→ Reports
→ Windows accuracy pilot
→ macOS detection agent
→ macOS accuracy pilot
→ Cross-platform public pilot
```

## Final Platform Strategy

Authenti8 should be designed as a cross-platform system from the beginning, but the candidate detector must not be treated as one identical application on both operating systems.

Use:

- Shared backend
- Shared event schemas
- Shared rule format
- Shared recruiter UI
- Shared reports
- Platform-specific Windows detector
- Platform-specific macOS detector
- Separate Windows and macOS accuracy testing

This approach allows Authenti8 to work on both Windows and macOS without weakening detection quality.

---

# To Do Before Launch

## Define Which Launch

The immediate launch is a controlled design-partner pilot, not public general
availability. The team should use three explicit release levels:

```text
DESIGN-PARTNER PILOT
    White-glove, Windows 11, Google Meet, limited supported tool/version,
    small interview count, Authenti8 operator present

PAID BETA
    Repeatable onboarding, hardened installer, reliable automation,
    multiple validated detection packs, support and incident processes

GENERAL AVAILABILITY
    Enterprise security controls, contractual commitments, scalable
    operations, broader platform support, and independently defensible metrics
```

No pitch, contract, or interface should describe pilot capabilities as generally
available production coverage.

## Product Contract to Lock

- Choose the exact first supported tool and tested version range.
- Lock Windows 11 as the one-week pilot platform.
- Decide the supported Google Meet interview-registration workflow for the
  pilot and label any operator-assisted step clearly.
- Define the eligible monitoring window and grace periods.
- Define what counts as monitoring successfully started.
- Define credit/refund behavior for declined, interrupted, and failed sessions
  before charging design partners.
- Keep the technical result and monitoring status as separate stored fields and
  separate UI concepts.
- Require unique tool identity, active use, and a valid evidence chain for every
  `CONFIRMED` result.
- Define which evidence recruiters may see and which technical details remain
  restricted to Authenti8.
- Define a supported-tool/version coverage statement that appears in the live
  view and final report.

## Detection and Accuracy Work

- Create clean, reproducible Windows 11 research images.
- Capture official samples for the selected tool through authorized means.
- Document identity signals and active-use signals separately.
- Model evidence ancestry so multiple fields from one source are not counted as
  independent proof.
- Build installed-but-closed, active, minimized, renamed, restarted, and
  network-loss scenarios.
- Build the first legitimate-application corpus, including Google Meet, Slack,
  Teams, Zoom, VS Code, password managers, accessibility tools, screen
  recorders, transcription tools, and virtual-audio software.
- Version every validation run by agent, operating system, tool, and rule pack.
- Require a second human review before a rule is enabled for a candidate pilot.
- Define an immediate rule-disable and report-review procedure.
- Record misses and false-confirmation disputes without silently rewriting old
  reports.

## End-to-End Product Work

- Recruiter can create or receive an operator-created protected session.
- Candidate receives a working verification URL with enough setup time.
- Consent language identifies the employer, purpose, data, duration, retention,
  and candidate choice.
- Candidate can install/open the signed agent and complete preflight.
- Device enrollment is single-use, expiring, and session-bound.
- Monitoring begins and ends only under the defined session policy.
- Heartbeats and interruptions are measured.
- Signed evidence reaches the correct organization and interview.
- Recruiter sees live status without seeing unrelated device information.
- Refresh and reconnect restore the current live state.
- Final report is reproducible and includes limitations.
- Candidate and recruiter receive clear recovery instructions.

## Security and Privacy Work

- Threat-model malicious candidates, compromised activation links, forged
  agents, replayed events, leaked detection packs, tenant crossover, and
  privileged insiders.
- Sign the Windows binary and document what is prototype-signed versus
  production-signed.
- Use TLS and short-lived, session-bound credentials.
- Encrypt sensitive evidence and secrets at rest.
- Enforce organization isolation at every API and database boundary.
- Prohibit telemetry before consent at both the agent and ingestion service.
- Upload matched/minimal evidence rather than complete process lists, screens,
  audio, files, messages, or browsing history.
- Stop sensors and delete ephemeral device keys when the session ends.
- Define pilot retention periods and perform deletion tests.
- Log administrative access to candidate evidence.
- Prepare a security-contact and incident-escalation procedure.

## Pilot Operations

- Select a small number of design partners who understand the experimental
  scope.
- Use written pilot terms and candidate-facing disclosure reviewed by counsel.
- Schedule pilot interviews only when Authenti8 support is available.
- Run a technical preflight with the recruiter and a non-candidate test device.
- Provide candidate system requirements before the interview.
- Maintain a fallback interview policy if verification fails.
- Never advise a recruiter to reject a candidate automatically.
- Establish a candidate dispute and evidence-review contact.
- Record every setup failure, permission failure, interruption, false alert,
  support request, and recruiter interpretation problem.
- Hold a review after every pilot interview before expanding volume.

## Pilot Metrics

Measure the complete workflow, not only whether a demo detection fired:

- Recruiter onboarding completion rate.
- Candidate verification completion rate.
- Median and p95 time to install, consent, and begin monitoring.
- Percentage of eligible interview time successfully monitored.
- Detection latency for the supported active tool.
- Confirmations in prohibited-tool tests.
- Confirmations in the legitimate clean corpus.
- Agent crash and interruption rates.
- Verification-email or activation-link delivery failures.
- Recruiter comprehension of `CONFIRMED`, `NOT_DETECTED`, and monitoring status.
- Candidate objections and support burden.
- Reports successfully reproduced from evidence.
- Design-partner willingness to run another interview and willingness to pay.

## External Pilot Go/No-Go Checklist

```text
[ ] Exact pilot scope and supported coverage are written down
[ ] Candidate disclosure and consent flow are approved
[ ] One supported tool/version passes repeatable active-use tests
[ ] Installed-but-inactive test passes
[ ] Clean corpus has zero confirmed incidents
[ ] Evidence signing, ordering, replay rejection, and storage pass
[ ] Agent exit and connection-loss states pass
[ ] Monitoring stop and data-deletion tests pass
[ ] Live recruiter state and report agree
[ ] Report contains coverage and limitations
[ ] Recruiter and candidate runbooks exist
[ ] Authenti8 operator and escalation owner are assigned
[ ] Complete internal rehearsal passes immediately before the pilot
```

If any consent, evidence-integrity, false-confirmation, tenant-isolation, or
monitoring-stop item fails, the pilot is blocked. Visual polish and workflow
automation may be handled manually for a small pilot; trust and safety may not.

---

# Missing for a Sellable B2B Product

The design-partner pilot validates the core detection loop. It does not by
itself create software that a company can safely purchase and deploy at scale.
The following capabilities are required progressively for paid beta and general
availability.

## Enterprise Identity and Administration

- Granular roles for owners, administrators, recruiters, reviewers, billing,
  and read-only auditors.
- SAML/OIDC single sign-on.
- SCIM user and group provisioning.
- Session-management and organization-wide access revocation.
- Multiple domains, subsidiaries, teams, and interviewer groups.
- Configurable interview policies without allowing customers to alter technical
  verdicts.
- Customer-visible audit logs and export.
- Separation of customer support, security, and detection-research privileges.

## Security and Procurement Readiness

- Documented secure-development lifecycle.
- Independent penetration test and remediation evidence.
- Vulnerability disclosure and security-contact process.
- Software bill of materials for web, backend, extensions, and native agents.
- Dependency, secret, binary-signing, and supply-chain controls.
- Disaster-recovery plan with tested restore objectives.
- Security whitepaper, architecture diagram, and customer questionnaire pack.
- SOC 2 readiness and an evidence-collection program; certification timing can
  follow customer demand.
- Vendor-risk documentation, subprocessors, and hosting-region disclosure.
- Defined security incident notification commitments.

## Privacy and Legal Readiness

- Counsel-approved candidate disclosure and consent language for each launch
  market.
- Employer/customer data-processing agreement.
- Clear controller/processor responsibilities.
- Candidate access, correction, deletion, and dispute procedures.
- Configurable retention with verified deletion.
- Cross-border transfer and data-residency strategy.
- Accessibility and reasonable-accommodation workflow.
- Policy prohibiting automatic adverse employment decisions.
- Contract language defining supported coverage and limitations.
- Review of employment-monitoring, privacy, works-council, and local consent
  requirements before entering a jurisdiction.

## Native Agent Productization

- Production Windows Authenticode signing and reputation management.
- Signed and notarized macOS distribution when macOS is launched.
- Secure updater with signed manifests, staged rollout, rollback, and minimum
  supported versions.
- Antivirus, EDR, managed-device, proxy, and firewall compatibility testing.
- Standard-user installation wherever technically possible.
- Clear uninstall, cleanup, and session-ending guarantees.
- Crash recovery and diagnostic collection that excludes sensitive device data.
- Supported operating-system lifecycle policy.
- Enterprise deployment options where customers manage interview devices.

## Detection Operations

- A maintained threat-research lab, not one-time signatures.
- Authorized sample acquisition and isolated research environments.
- Versioned tool catalog stating exactly what is supported.
- Rule review, signing, expiry, revalidation, rollout, and rollback.
- Continuous clean-corpus regression testing.
- Fast response when a supported tool updates.
- False-confirmation dispute review with restricted evidence access.
- Accuracy reports separated by operating system, agent, rule pack, tool, and
  tool version.
- Statistical confidence intervals and minimum sample sizes for published
  performance claims.
- Independent validation before making strong accuracy claims.

## Reliability and Support

- Repeatable Calendar synchronization and webhook recovery.
- Hardened recruiter extension plus a web fallback.
- Queue retry policies, dead-letter handling, and idempotent jobs.
- Service-level objectives for ingestion, live updates, and report generation.
- Status page, alerting, on-call ownership, and incident runbooks.
- Correlation IDs that trace an interview across every service.
- Safe report regeneration and evidence verification tooling.
- Customer support workflow with severity and response targets.
- Candidate support that does not expose restricted detection rules.
- Capacity and failure testing before contractual volume commitments.

## Commercial Product Capabilities

- Plans based on a clear value metric such as protected interviews.
- Idempotent subscription, credit, refund, and invoice ledger.
- Trials and design-partner conversion process.
- Organization billing contacts and tax-compliant invoices.
- Usage and renewal reporting.
- Customer onboarding, implementation, and training materials.
- Contract templates, service terms, acceptable-use policy, and SLA.
- CRM pipeline, design-partner feedback loop, and renewal ownership.
- Product analytics that avoid collecting candidate surveillance data.

## Product Experience

- Reliable automatic Google Calendar discovery and classification.
- Preflight that happens early enough to solve installation and permission
  problems without monitoring before consent.
- Recruiter extension that survives Google Meet UI changes.
- Clear live separation of detection, monitoring health, and coverage.
- Reports understandable to non-technical hiring teams.
- Candidate-facing explanations in accessible language.
- Dispute and evidence-review workflow.
- Multi-interviewer and rescheduled/cancelled interview handling.
- Tested email delivery and alternative activation recovery.
- Responsive dashboard, searchable history, exports, and notifications.

## What Is Not Required for the First Controlled Pilot

The following may remain incomplete during a small, supervised, unpaid or
contractually limited design-partner pilot:

- SAML and SCIM.
- Self-service billing.
- Full internal admin tooling.
- Multi-region deployment.
- The 100,000-concurrent-session target.
- Teams, Zoom, and Webex.
- macOS support.
- Multiple supported tool families.
- SOC 2 certification.

They cannot remain indefinitely absent once customers depend on Authenti8 for
real hiring operations.

---

# Product Positioning and Pitch Guardrails

## Correct Product Category

Authenti8 is a consent-based interview endpoint-integrity platform with a
continuously maintained detection-research layer. It complements existing video
meeting and applicant-tracking workflows; it does not replace them and does not
evaluate candidate skill.

## Approved Core Pitch

> Authenti8 helps hiring teams identify active use of specifically supported
> real-time AI interview-assistance tools during consented live interviews. It
> uses validated technical evidence from the candidate device, shows private
> live status to the recruiter, and produces an auditable report with monitoring
> coverage and limitations.

## Claims Authenti8 May Make After Validation

- Detects named, supported tool versions on tested operating systems.
- Requires technical identity and active-use evidence.
- Does not use gaze, facial expression, nervousness, accent, or answer quality.
- Does not upload raw screens, raw audio, personal files, or messages in the
  defined product design.
- Separates detection results from monitoring interruptions and coverage.
- Preserves evidence needed to explain and reproduce a confirmed result.

Every claim must be limited to the platforms, versions, scenarios, and metrics
that have actually passed validation.

## Claims Authenti8 Must Not Make

- “Detects all cheating.”
- “Impossible to bypass.”
- “Proves the candidate did not cheat.”
- “Detects any AI tool.”
- “Works on phones and secondary computers.”
- “100% accurate.”
- “A declined or interrupted verification means cheating.”
- “Automatically determines whether a candidate should be rejected.”

## Founder and Hiring-Team Value

- Continue using the original Google Meet workflow.
- Receive evidence instead of behavioral suspicion scores.
- Identify active use of a defined catalog of high-risk tools.
- Understand exactly how much of the interview was verified.
- Keep the technical verdict separate from the final hiring decision.
- Review a consistent report after the interview.

## Investor Framing

The initial wedge is protecting live interviews from a fast-changing catalog of
real-time AI assistance tools. The durable asset is the combination of:

- Native endpoint visibility.
- A privacy-conscious evidence model.
- A cross-platform normalized detection architecture.
- Proprietary tool signatures and clean-corpus validation.
- A continuous threat-research and rule-release operation.
- Workflow distribution through calendars and meeting platforms.

The defensibility is not the dashboard alone. It is the accumulated detection
research, validation corpus, evidence integrity, operating-system expertise,
and customer trust required to make a `CONFIRMED` result credible.

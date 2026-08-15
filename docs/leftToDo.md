# Authenti8 Launch Checklist

This file tracks work that depends on purchases, external accounts, production credentials,
real devices, legal decisions, or launch operations. Repository implementation status remains in
`docs/phases.md`.

## Launch Scope

The first launch is a controlled design-partner pilot:

- Windows 11 candidates
- Google Meet interviews
- A limited, explicitly validated set of detection rules
- Small interview volume with Authenti8 support available
- No claim of macOS, mobile, or general-purpose cheating detection until separately validated

## Already Prepared

- [x] Windows development workflow for disposable test VMs
- [x] Production-channel staging workflow
- [x] Persistent self-signed staging certificate stored outside the repository
- [x] Staging certificate fingerprint binding
- [x] Permanent rule-pack and update verification public keys
- [x] Encrypted staging artifacts and fail-closed signature validation
- [x] Production API origin selected as `https://authenti8.com`

The self-signed staging certificate is only for controlled VMs. Never distribute a staging build
to real candidates and never publish it as a production release.

## Purchases and External Accounts

### Required for the Windows pilot

- [ ] Pay the one-time Chrome Web Store developer registration fee.
- [ ] Purchase a publicly trusted Windows code-signing service/certificate.
  Prefer cloud signing or an HSM-backed private key. Confirm that the provider supports automated
  signing from GitHub Actions and RFC 3161 timestamping before purchase.
- [ ] Purchase or configure durable installer hosting and bandwidth.
  Use `downloads.authenti8.com` when available; an object store/CDN is preferred over GitHub Actions
  artifacts because candidate links must be stable and public.
- [ ] Configure transactional email service and authenticate the sending domain with SPF, DKIM,
  and DMARC.
- [ ] Obtain legal review for pilot terms, privacy notice, candidate consent, retention, deletion,
  acceptable use, and detection-result limitations.

### Required only when expanding scope

- [ ] Apple Developer Program membership for macOS distribution.
- [ ] Apple Developer ID Application certificate, hardened runtime, notarization, and stapling.
- [ ] macOS release runner and macOS validation devices.

Record purchase owner, renewal date, recovery contacts, and billing account in the private company
operations system. Do not store private keys, passwords, recovery codes, or certificate bundles in
this document or in Git.

## Chrome Extensions

Authenti8 has two different Chrome extensions. Do not reuse or swap their IDs.

### Candidate extension

- [ ] Register the Authenti8 publisher account in the Chrome Web Store.
- [ ] Build and upload `apps/candidate-extension` as an unpublished draft.
- [ ] Copy its permanent 32-character Item ID.
- [ ] Add that ID as the GitHub `staging` environment secret
  `AUTHENTI8_CHROME_EXTENSION_ID`.
- [ ] Save the Web Store public key in the candidate extension manifest so development and
  packaged builds resolve to the same identity.
- [ ] Complete store listing, privacy disclosures, permissions justification, screenshots, support
  URL, and verification requirements.
- [ ] Publish with the minimum visibility required for the pilot.
- [ ] Verify that the Windows native-messaging manifest allows only this extension ID.

### Recruiter extension

- [ ] Build and upload `apps/recruiter-extension` as its own Web Store item.
- [ ] Copy its distinct permanent Item ID into the deployed server environment as
  `RECRUITER_EXTENSION_ID`.
- [ ] Complete its separate listing, permission justification, review, and distribution settings.
- [ ] Verify token provisioning and Google Meet live-log behavior with the published extension.

## Replace Self-Signed Windows Signing

The launch build must not use `WINDOWS_STAGING_CERT_*` or require candidates to import a
certificate manually.

- [ ] Select and purchase the trusted code-signing provider.
- [ ] Complete the provider's identity/organization verification.
- [ ] Keep the production signing key non-exportable in the provider's cloud signer or HSM.
- [ ] Create a separate protected GitHub `production` environment restricted to approved release
  tags and required reviewers.
- [ ] Integrate the provider's signing client into a dedicated production release workflow.
- [ ] Pin third-party GitHub Actions and signing dependencies to immutable revisions.
- [ ] Configure an RFC 3161 timestamp URL so signatures remain valid after certificate expiry.
- [ ] Sign and verify all release executables:
  `Authenti8Verify.exe`, `Authenti8VerifyNativeHost.exe`, and `Authenti8VerifySetup.exe`.
- [ ] Fail the release unless every signature is valid, chains to the intended trusted publisher,
  has the Code Signing EKU, and carries a valid timestamp.
- [ ] Record the expected publisher identity/fingerprint through protected configuration.
- [ ] Test install, upgrade, rollback, uninstall, and Windows SmartScreen behavior on clean VMs.
- [ ] Rotate or renew the certificate before expiry without changing the Authenti8 publisher name.
- [ ] Preserve the staging workflow for internal testing; do not overwrite its certificate secrets
  with production credentials.

## Production Installer and Update Distribution

- [ ] Create the download origin, preferably `downloads.authenti8.com`.
- [ ] Point the subdomain to versioned object storage/CDN with TLS enabled.
- [ ] Upload immutable versioned installers and release archives.
- [ ] Serve a stable candidate URL for the current installer, for example:
  `https://downloads.authenti8.com/windows/Authenti8VerifySetup.exe`.
- [ ] Set the Vercel production environment variable:
  `NEXT_PUBLIC_WINDOWS_AGENT_INSTALLER_URL=<stable HTTPS installer URL>`.
- [ ] Redeploy the web application after setting the `NEXT_PUBLIC_` value because it is embedded at
  build time.
- [ ] Generate the signed Windows update manifest and set `WINDOWS_RELEASE_MANIFEST_JSON` on the
  server.
- [ ] Confirm the manifest URL, version, SHA-256 hash, size, and Ed25519 signature match the uploaded
  release archive.
- [ ] Configure cache headers so versioned files are immutable while the stable installer alias can
  be updated safely.
- [ ] Enable access logs, integrity monitoring, rollback, and an emergency release-disable process.
- [ ] Never use an expiring GitHub Actions artifact URL as
  `NEXT_PUBLIC_WINDOWS_AGENT_INSTALLER_URL`.

## Secrets and Environment Configuration

### GitHub `staging` environment

- [x] `AUTHENTI8_API_ORIGIN=https://authenti8.com`
- [x] `AUTHENTI8_RULE_PACK_PUBLIC_KEY`
- [x] `AUTHENTI8_UPDATE_PUBLIC_KEY`
- [x] `WINDOWS_STAGING_CERT_PFX_BASE64`
- [x] `WINDOWS_STAGING_CERT_PASSWORD`
- [x] `WINDOWS_STAGING_ARTIFACT_PASSWORD`
- [x] `WINDOWS_STAGING_CERT_SHA256` as a non-secret environment variable
- [ ] `AUTHENTI8_CHROME_EXTENSION_ID`
- [ ] Restrict deployments to protected `main` only.
- [ ] Run the staging workflow successfully and retain its verification evidence.

### Production application/server

- [ ] Set production origins and `.authenti8.com` session-cookie domain.
- [ ] Set Supabase server credential and browser publishable credential.
- [ ] Configure Google OAuth and Calendar production callback URLs.
- [ ] Configure Dodo production mode, product IDs, API key, and verified webhook secret.
- [ ] Configure SMTP, sender-domain authentication, and mail encryption key.
- [ ] Configure a strong `CRON_SECRET` and restrict cron callers.
- [ ] Set the distinct `RECRUITER_EXTENSION_ID`.
- [ ] Set the signed candidate `CHROME_RULE_PACK_JSON` bootstrap pack.
- [ ] Set `WINDOWS_RELEASE_MANIFEST_JSON` only after the production artifact exists.
- [ ] Set `NEXT_PUBLIC_WINDOWS_AGENT_INSTALLER_URL` in Vercel only after the URL is live.
- [ ] Store private signing keys only in an appropriate secret manager or signing service.
- [ ] Document rotation and recovery procedures without recording secret values.

## Database and Scheduled Operations

- [ ] Apply every committed PostgreSQL migration to production in order.
- [ ] Verify `schema_migrations` contains every expected migration exactly once.
- [ ] Run tenant-isolation and authorization smoke tests against production configuration.
- [ ] Configure required scheduled jobs for mail, Calendar maintenance, billing reconciliation,
  monitoring orchestration, and retention/deletion.
- [ ] Verify scheduled jobs authenticate with the intended secret and produce observable failures.
- [ ] Back up production data and complete one restore rehearsal before paid use.

## Detection Readiness

- [ ] Select the exact first supported prohibited tool and supported versions.
- [ ] Acquire samples lawfully and document their hashes and provenance privately.
- [ ] Build clean and positive Windows 11 test corpora.
- [ ] Validate installed-but-closed, active, minimized, renamed, restarted, update, offline, and
  interrupted-monitoring scenarios.
- [ ] Validate legitimate apps that may resemble detection signals.
- [ ] Require unique identity evidence plus active-use evidence for every confirmed result.
- [ ] Obtain second-person approval before publishing a detection rule.
- [ ] Sign and publish the first production rule pack.
- [ ] Test emergency rule disable, rollback, and report review.
- [ ] Do not ship placeholder, guessed, or unvalidated cheating-tool hashes.

## End-to-End Launch Verification

- [ ] Use a clean Windows 11 VM with no staging certificate installed.
- [ ] Install the production artifact without certificate warnings.
- [ ] Verify the installer, agent, and native host signatures and publisher name.
- [ ] Create a real protected interview from the recruiter workflow.
- [ ] Deliver and open the candidate verification link.
- [ ] Complete consent, enrollment, preflight, and monitoring start.
- [ ] Verify candidate and recruiter extension identities and native messaging.
- [ ] Verify heartbeats, interruptions, reconnects, and authorized stop behavior.
- [ ] Verify recruiter live logs update, remain tenant-isolated, and recover after refresh.
- [ ] Verify confirmed detections require the intended evidence and appear in the final report.
- [ ] Verify update install, rollback, uninstall, and ephemeral-key cleanup.
- [ ] Verify retention and deletion jobs remove only eligible data.
- [ ] Verify payment success, webhook replay, cancellation, refunds, and credit reconciliation.
- [ ] Run accessibility, privacy, security, and browser compatibility checks.
- [ ] Record release hashes, signer identity, versions, migration state, and approval evidence.

## Launch Gate

Do not give the installer to candidates until all of these are true:

- [ ] Candidate and recruiter extension IDs are permanent and correctly separated.
- [ ] Windows executables are signed by the publicly trusted production publisher and timestamped.
- [ ] The installer URL is stable, HTTPS-only, live, and configured in the production web build.
- [ ] Release/update metadata and the first detection pack are signed and verified.
- [ ] Production migrations, scheduled jobs, backups, monitoring, and alerts are operational.
- [ ] A clean-device end-to-end interview passes without importing the staging certificate.
- [ ] Legal documents, candidate consent, retention, support, and incident procedures are approved.
- [ ] Pilot limitations and supported tool/version coverage are shown clearly to recruiters.


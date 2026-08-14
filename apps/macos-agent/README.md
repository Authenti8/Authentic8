# macOS agent

The macOS verifier enrolls a short-lived Ed25519 device identity, stores it in
Keychain, collects consent-scoped process/window/audio metadata through the
native Swift sensor, normalizes evidence into the shared telemetry schema, and
sends an ordered signed hash chain. Missing Accessibility or Screen Recording
permission is reported as incomplete coverage rather than as a clean result.

`npm run package:macos -w @authenti8/macos-agent` builds the Swift helper and
requires Apple signing/notarization environment variables before producing a
release artifact.

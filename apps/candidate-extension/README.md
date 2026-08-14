# Candidate extension

Manifest V3 extension for consented browser-tool detection. It uses Chrome's
management API locally, compares only IDs against an administrator-provided
signature set, and forwards matched IDs plus active-profile health to the
`com.authenti8.verify` native host. Names, permissions, and the full extension
inventory never leave the browser profile.

# Authenti8 Verify for Windows

The Windows 11 pilot agent enrolls one device with an ephemeral Ed25519 key,
collects process, top-level window, and Core Audio endpoint changes locally,
and submits a signed, ordered evidence chain. Full process lists never leave
the candidate device.

The installer refuses an unsigned `Authenti8Verify.exe`, registers the
`authenti8://` protocol, and provides per-user uninstall support. Release
packaging must replace the native-messaging placeholders and Authenticode-sign
the executable before distribution. Signed update manifests and downloaded
package hashes are verified by `update-verifier.ts`. Updates are complete release
archives so the signed executable, native sensors, and installer assets advance
together; the helper restores the prior native directories if replacement fails.
`package:windows` also embeds that archive in the signed
`Authenti8VerifySetup.exe` used for the candidate download-and-open flow.
The same build emits a signed `Authenti8VerifyNativeHost.exe` implementing
Chrome's framed native-messaging status protocol; packaging requires the
production `AUTHENTI8_CHROME_EXTENSION_ID`.

## Development installer

The manually triggered `Windows Agent Development Build` GitHub Actions workflow produces a
self-signed installer for controlled Windows 11 test VMs. It embeds a seven-day, cryptographically
signed empty rule pack, disables remote update checks for that development build, and deliberately
omits Chrome native-messaging registration until the candidate extension has a real ID. Enrollment,
code-integrity checks, Windows sensors, ordered telemetry, and uninstall behavior remain enabled.

Before running the workflow, create the repository Actions secret
`WINDOWS_DEVELOPMENT_ARTIFACT_PASSWORD` with a unique 20-or-more-character password and share it
only with authorized testers. The public workflow uploads only an AES-256 encrypted, header-encrypted
`authenti8-windows-development.7z`; the installer and development certificate are never uploaded in
plaintext. Extract it inside the test VM with 7-Zip and the separately shared password.

The encrypted archive contains `Authenti8VerifySetup-Development.exe`,
`Authenti8Development.cer`, and SHA-256 checksums. After extraction, import the public certificate
only into a disposable test VM, verify the hashes against `SHA256SUMS.txt`, and verify the installer
before running it:

```powershell
Import-Certificate -FilePath .\Authenti8Development.cer `
  -CertStoreLocation Cert:\CurrentUser\Root
Import-Certificate -FilePath .\Authenti8Development.cer `
  -CertStoreLocation Cert:\CurrentUser\TrustedPublisher
Get-AuthenticodeSignature .\Authenti8VerifySetup-Development.exe
```

The signature status must be `Valid`. Never distribute this build to candidates or publish it as a
GitHub Release. Production packaging remains fail-closed and still requires the production
rule/update keys, Chrome extension ID, trusted certificate, and timestamp.

The repository does not contain production cheating-tool hashes. Enable a rule
only after the exact tool/version and legitimate clean corpus pass Phase 28.

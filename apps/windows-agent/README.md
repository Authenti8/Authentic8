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

## Production-channel staging installer

The manually triggered `Windows Agent Staging Build` workflow exercises the production package
path with the deployed API, permanent rule/update public keys, real candidate extension ID, and a
persistent self-signed staging code-signing certificate. Configure these secrets in the GitHub
`staging` environment before running it:

- `AUTHENTI8_API_ORIGIN`
- `AUTHENTI8_RULE_PACK_PUBLIC_KEY`
- `AUTHENTI8_UPDATE_PUBLIC_KEY`
- `AUTHENTI8_CHROME_EXTENSION_ID`
- `WINDOWS_STAGING_CERT_PFX_BASE64`
- `WINDOWS_STAGING_CERT_PASSWORD`
- `WINDOWS_STAGING_ARTIFACT_PASSWORD` (a unique password containing at least 20 characters)

Also configure the non-secret `staging` environment variable
`WINDOWS_STAGING_CERT_SHA256=52DA5246580C27D55BDC63303CDAF737A4C9408096681D5EACAA65A6E69C7D82`.
This binds staging builds to the persistent certificate generated for this environment.

Configure the `staging` environment deployment-branch rule to allow only the protected `main`
branch. The workflow independently rejects every other Git ref before the environment is granted.

The workflow imports the PFX only for the build, verifies that all three executables have the exact
expected signature, encrypts the installer, public certificate, and SHA-256 checksums into a
header-encrypted AES-256 7-Zip archive, publishes that archive for 14 days, then removes the
certificate and PFX from the runner. Share the artifact password separately from the archive.
After extraction, import the included public certificate into `CurrentUser\Root` and
`CurrentUser\TrustedPublisher` only on controlled staging VMs. Never distribute this self-signed
build to candidates or publish it as a GitHub Release.

For launch, replace the staging signer with a publicly trusted code-signing provider and rebuild.
The API origin, rule/update keys, extension identity, package validation, and update trust roots stay
unchanged unless intentionally rotated.

The repository does not contain production cheating-tool hashes. Enable a rule
only after the exact tool/version and legitimate clean corpus pass Phase 28.

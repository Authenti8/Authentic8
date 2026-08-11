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

The repository does not contain production cheating-tool hashes. Enable a rule
only after the exact tool/version and legitimate clean corpus pass Phase 28.

## iOS simulator: golden flow G5 (a published report)

The CI job `ios-simulator-published (iphone)` runs the same behaviour as the Android flow G5 on the iOS simulator: a published report opens read-only with a banner that names the version; "Edit and republish" opens it; a publish with nothing said is answered "Nothing to publish"; a second publish with a summary and the notice box ticked makes version 4, and the engine records `notifyClient: true`. It is a separate job and is not one of the required checks.

### Why HTTPS

The iOS build has no App Transport Security exception (`ios/App/App/Info.plist` has no `NSAppTransportSecurity` key), and it will not get one for a test. The fake engine the Android dev build talks to is plain http, so on iOS the fake engine runs over HTTPS (`e2e/fake-engine/serve.mjs --tls-cert <pem> --tls-key <pem>`, the same option the packaged Windows tests use) with a throwaway certificate for `localhost` and `127.0.0.1`. The certificate is added to the simulator's trusted roots (`xcrun simctl keychain <udid> add-root-cert <pem>`) after the simulator has booted and before the app is installed.

The ordinary release-style bundle is used. The "Allow plain http (development only)" switch exists only in a development bundle (`import.meta.env.DEV`) and is not needed for an `https://` address, so the iOS sign-in flow never touches it.

### Pieces

- `scripts/ios-simulator-published.sh <App.app> <engine origin> <control url> <certificate pem> [out]`: boots the iPhone simulator, trusts the certificate, installs and launches the app, runs part A, asks the engine (`scripts/lib/report-state.mjs`), runs part B, asks the engine again, saves screenshots and the app log, and fails on a crash report of the app. It refuses an `http://` engine address. `SIM_UDID` pins a simulator.
- `maestro/ios/sign-in.yaml`, `g5-a-published-report.yaml`, `g5-b-republish-with-notice.yaml`: the iOS flows. They differ from `maestro/golden/` in three ways: the address field is selected by tapping its text three times instead of tapping at a screen percentage; the "checked" assertions on the notice box are left to the engine check (whether a web checkbox reports "checked" to Maestro on iOS is not verified); and sign-in optionally taps "Open" in case iOS asks before returning to the app.
- `scripts/lib/ios-published.test.ts`: tests the runner with a stand-in `xcrun`, `maestro` and control server (order of calls, refusal of http, what happens when the engine disagrees with the screen).

### What the job does, in order

Build exactly as `ios-simulator` does (Swift package cache included, but without Capacitor logging: only the `ios-simulator` job may turn that on), install GNU timeout, install Maestro 2.12.0 from its release page with the SHA-256 checked before unpacking (same pin as the Android workflow: move `MAESTRO_VERSION` and `MAESTRO_SHA256` together; macOS has `shasum -a 256`, not `sha256sum`), set up Java 21 for Maestro, generate the certificate, start the engine with `--scenario published` on a free port and check from the host that the certificate verifies (and that the same request without it fails), run the script, upload `ios-simulator-published-evidence`.

### What is not verified until the first CI run

- That Xcode 26 simulators trust the certificate added with `simctl keychain add-root-cert` for both the web view's requests and the sign-in browser, and that `localhost` on the simulator reaches the host's loopback (it shares the host network; the engine listens on 127.0.0.1 only).
- That Maestro 2.12.0 starts its iOS driver on the runner without anything beyond the zip and a JDK.
- That the sign-in works end to end: the Browser plugin opens the sign-in page, the engine redirects to `io.inspectorhub.app://oauth/callback`, and iOS hands it to the app without a prompt Maestro cannot see (a system sheet raised outside the app is the likeliest failure).
- (Seen on the first CI run, 2026-11-05: the build, Maestro install, certificate, HTTPS engine and the trust of the root all worked, and the app reached its server screen. `simctl keychain add-root-cert` refuses a shut-down simulator on this Xcode (`Unable to lookup in current state: Shutdown`), so the script boots first and adds the root then. A triple tap on the pre-filled address selected only part of it, so the flow now taps at the end of the field and erases a fixed number of characters. On the 2026-11-05 G5 run, Maestro timed out waiting for the "Work list" heading even though the failure screenshot showed the signed-in list and the fake engine had served it. The sign-in flow now waits for its primary "Download today's work" action instead.)
- That `hideKeyboard` dismisses the keyboard over the summary field, and that the accessible names the Android flows use ("Open 77 Test Photo Lane", "A Roof cover") are what Maestro sees on iOS.
- A simulator that was used before keeps secure-store items across an uninstall (keychain); on a reused machine, erase the simulator first. A fresh CI runner needs nothing.

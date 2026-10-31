# Development

This page covers the local setup for Android and Windows (Electron). iOS is documented separately.

## Prerequisites

| Tool | Version | Note |
|---|---|---|
| Node.js | 22+ | Capacitor 8 requires it |
| JDK | 21 | Used only through `scripts/dev-env.ps1`; your global `JAVA_HOME` is not changed |
| Maestro | 2.11+ | End-to-end flows; unzip the release to a directory of your choice and put its `bin` on PATH (`dev-env.ps1` does this when `MAESTRO_HOME` is set) |
| Android SDK | platform 36, build-tools 36.0.0, platform-tools | Command-line tools are enough; Android Studio is optional |

Set two user-level variables once: `ANDROID_HOME` and `GRADLE_USER_HOME` (Gradle's cache is large; keep it off the system drive).

## Session setup (PowerShell)

```powershell
. .\scripts\dev-env.ps1
```

Machine-specific paths go in `scripts/dev-env.local.ps1` (gitignored).

## Running Gradle on Windows

Call the wrapper with an explicit `.\` prefix from the `android` directory:

```
cd android
cmd /c ".\gradlew.bat assembleDebug --console=plain"
```

Without the prefix, cmd may report that `gradlew.bat` is not recognized when `NoDefaultCurrentDirectoryInExePath` is set.
A cold first build takes roughly 15-20 minutes; run `gradlew --stop` afterwards to release the daemon's memory.

## Debugging on a real Android device (USB)

1. Enable Developer options, then USB debugging. Choose "File transfer" as the USB mode.
2. Confirm `adb devices` lists the phone as `device` (not `unauthorized`).
3. Forward the engine and the Vite dev server to the phone:

```
adb reverse tcp:8787 tcp:8787
adb reverse tcp:5173 tcp:5173
```

4. Start the engine from your OpenInspection checkout with `NATIVE_CLIENT_ENABLED=1` in `.dev.vars`, then the app's Vite server, then:

```
npx cap run android --live-reload --host localhost --port 5173
```

5. In the app, enter `http://localhost:8787` as the server address. Cleartext HTTP is allowed in debug builds only.

When you are done, stop the dev servers first, then run `adb reverse --remove-all`.

`capacitor.config.ts` must never contain `server.url`; live reload exists only as command-line flags. CI checks this.

### Huawei / Honor (EMUI) devices

`adb devices` can stay empty even with USB debugging on:

- Turn off "Allow HiSuite to connect via HDB" in Security settings, then toggle USB debugging off and on.
- HiSuite's background service can hold the ADB interface open (`adb` logs `Failed to open device handle ... Error [5]`). Stop `HuaweiHiSuiteService64.exe` and its `hdbtransport`/`hwtransport` processes from an elevated shell, or uninstall HiSuite.
- `adb install` may wait for a confirmation dialog on the phone.

## Windows (Electron)

The Windows pilot runs the same `src/` app as Android in an Electron shell. Use Node.js `^22.22.2`, `^24.15.0`, or `>=26.0.0` (see `package.json`); on Windows, install the dependencies from the repository root with `npm ci`.

```
npm run dev:electron
```

`dev:electron` watches and builds the Electron renderer and main/preload bundles, then launches Electron. It does not start the web Vite development server: the desktop shell must exercise the same local `https://localhost` protocol handler and strict CSP used by the packaged app. For the normal local sign-in flow, start the OpenInspection engine separately with `NATIVE_CLIENT_ENABLED=1` in its `.dev.vars`; its default local address is `http://localhost:8787`. In the app, enter that address as the server URL. The desktop app uses the system browser for OAuth and returns through the registered `io.inspectorhub.app` protocol.

`npm run build:electron` builds the main process and preload script to CommonJS with esbuild, then builds the renderer. `npm run typecheck` checks `src/` and `electron/` with separate tsconfigs, so Node and DOM types never mix.

### Local data, logs, and reset

By default, the app stores its profile under `%APPDATA%\InspectorHub` (typically `C:\Users\<you>\AppData\Roaming\InspectorHub`). The profile includes the encrypted database under `db/`, OS-protected secrets under `secrets/`, media/cache files, `kv.json`, and rotating logs under `logs/`. Settings → Open logs opens the log directory. Do not copy the `secrets/` directory to another Windows account or machine: Electron `safeStorage` protects it with the current Windows user context.

To run an isolated development instance, pass Electron's standard `--user-data-dir` switch, for example:

```powershell
npm run build:electron
npx electron . --user-data-dir="$env:TEMP\InspectorHub-dev-profile"
```

The switch changes only that instance's profile; it is separate from the development-only `OI_USER_DATA_DIR` override. To reset a profile, quit the app first, rename or back up its whole profile directory, then start the app again. Resetting or uninstalling deletes local offline work only if you delete that profile yourself. The NSIS uninstaller is configured to preserve AppData.

Development builds register `io.inspectorhub.app` to the Electron executable and current app script. A forced process termination can leave that Windows protocol registration pointing to the development tree; start and cleanly quit the same development build, or install another build, to refresh/remove it. Packaged builds register the installed app. Avoid launching a stale development checkout from OAuth callbacks.

### Electron tests and installer smoke

Run the desktop Playwright suite against the fake loopback engine with:

```powershell
npm run test:e2e:electron
```

This launches a development build and uses isolated temporary profiles and test-only engine routes; it does not test a production server or real Windows HEIF codecs. To create and inspect a local unsigned x64 installer:

```powershell
npm run package:win
npm run check:electron-package
```

Then run the install/launch/protocol/uninstall smoke (it uses a temporary install and profile, and checks that user data survives uninstall):

```powershell
scripts\smoke-installer.ps1
```

The smoke script stops if the current-user `io.inspectorhub.app` protocol handler already exists. `-Force` is only for a maintainer who has verified that the existing registry entry can be restored; the script exports and restores that entry. An unsigned pilot installer may trigger Microsoft SmartScreen; the pilot has no signing certificate and automatic updates are disabled for unsigned builds.

`npm run check:electron-package` inspects `release-win` by default; pass a directory to check another output, for example `node scripts/check-electron-package.mjs C:\temp\oi-1.0.0`.

### Local update rehearsal (two versions, loopback feed)

Never hand electron-builder `-c.publish.provider=generic -c.publish.url=...` on the command line: it is rejected ("configuration.publish should be one of these") because the config already sets a GitHub `publish` block. Instead set `OI_UPDATE_FEED_URL`, which `electron/builder/config-factory.mjs` honours for rehearsals only. It is off by default, and it accepts only an `http(s)` URL on `127.0.0.1` or `localhost` (no credentials); anything else makes the build fail, so a release build can never point at a stray feed. `-c.extraMetadata.oiSigned=true` is still needed: automatic updates stay disabled for builds that are not marked signed, and this flag marks the rehearsal build as one without producing a real signature.

1. Build version A and version B into separate output directories (bump `version` in `package.json` between the two, and restore it afterwards):

```powershell
$env:OI_UPDATE_FEED_URL = 'http://127.0.0.1:4545/'
npm run build; npm run build:electron; npm run build:heic-helper
npx electron-builder --config electron/builder/electron-builder.config.mjs --publish never -c.extraMetadata.oiSigned=true -c.directories.output=C:\temp\oi-rehearsal\a
# change the version, then repeat with output ...\b
Remove-Item Env:OI_UPDATE_FEED_URL
```

2. Serve version B's directory (it holds `latest.yml` and the installer) with `node scripts/local-update-feed.mjs C:\temp\oi-rehearsal\b 4545`.
3. Silently install version A (`InspectorHub-Setup-<A>.exe /S`), start it, and let the updater download B and reach `ready`; `installAndRestart` then relaunches the app as B.

**Profile hazard.** A packaged build ignores `OI_USER_DATA_DIR` (the development-only overrides are dropped when `app.isPackaged`), and only honours Chromium's `--user-data-dir` when it is passed on the command line. The updater's relaunch (`quitAndInstall`) does not forward `--user-data-dir`, and an app started from the Start menu or a protocol callback never has it. A rehearsal that does not isolate the profile therefore reads and writes your real `%APPDATA%\InspectorHub`. Do not run the packaged rehearsal on a machine or Windows account that holds real InspectorHub data: use a throwaway Windows user, a VM, or a machine with no real data. The app's behaviour is deliberately unchanged here.

The installer also registers nothing for `io.inspectorhub.app`; the app writes `HKCU\Software\Classes\io.inspectorhub.app` itself on first run. The NSIS uninstaller (`electron/builder/installer.nsh`) deletes that key, but only when its command launches the executable in the install directory being removed, so a stale key pointing elsewhere is left alone. It is skipped during an update. This script runs only inside a real NSIS uninstall and has not been executed in automated tests.

Budget 0.5–1 GB for the Electron app itself. Packaging and Playwright are also memory intensive: on a 16 GB development machine, do not run a full engine type-check, Gradle build, or emulator at the same time as `npm run package:win` or the full Electron E2E suite.

When recording acceptance evidence, keep screenshots in `.superpowers/sdd/<plan>/screenshots/<task>/`, use descriptive names, and record the window size and light/dark scheme in the matching progress note. Capture only synthetic or otherwise non-sensitive test data; Playwright screenshots show renderer content, not Windows-native dialogs, title bars, installer UI, taskbar, notifications, or SmartScreen.

Import boundaries, enforced by `src/electron-boundaries.test.ts`:

- Code in `src/` outside `src/desktop/` never imports `electron`.
- `src/desktop/` reaches the main-process directory only through `electron/shared/`.
- `electron/` imports only a short allowlist of pure `src` modules (database, schema, path helpers, callback constants, media types).

The local database uses `better-sqlite3-multiple-ciphers`, which ships prebuilt binaries for Electron's N-API ABI; no native compiler is needed.

The desktop shell serves local renderer files from `https://localhost`. Its page, script, and Worker responses share one strict CSP, including in development: neither `unsafe-eval` nor `wasm-unsafe-eval` is allowed. An earlier plan relaxed the Worker policy for a bundled WASM HEIC decoder. The 2026-10-27 revision moved decoding to a main-process system helper and removed that relaxation entirely. A future bundled decoder (L2) must revisit this decision together with the CSP tests.

### HEIC photos on Windows

HEIC import relies on Microsoft's Windows HEIF Image Extensions and HEVC Video Extensions. The app ships no HEVC decoder: `native/win-heic-helper/` builds a small native WIC helper, which is individually signed in Azure-signed builds. The main process checks the helper's SHA-256 against the value recorded in the packaged app before starting it. If Windows cannot create the required WIC decoder, the app rejects that photo with a short explanation and links to the Microsoft Store extension guidance; exporting the photo as JPEG on the phone is another option. The renderer has no bundled WASM decoder, which is why its CSP does not allow WASM execution. HDR PQ/HLG is not tone-mapped.

The only H0 extension-positive measurement recorded below is on Windows 11 Pro build 26300 with both extensions present. Windows 10 22H2, Windows 11 without one or both extensions, and default extension availability have not been compared, so do not infer a preinstall difference from that measurement.

### HEIC decoder H0 probe (2026-10-29)

The development machine reported Windows 11 Pro, version `10.0.26300` (64-bit). The current-user AppX inventory contained `Microsoft.HEIFImageExtension` 1.2.62.0 and `Microsoft.HEVCVideoExtension` 2.5.48.0. A one-off WIC COM probe returned `S_OK` when creating both the HEIF decoder and encoder components. This confirms the components are registered on that machine; the synthetic decode result is described below.

Initially, no HEIC fixture or `heif-enc` executable was available in the repository or on `PATH`. Three synthetic 64×48 WIC encoding variants using `WritePixels` failed with `0x80070057` (`E_INVALIDARG`). A follow-up using `CreateBitmapFromMemory` and `IWICBitmapFrameEncode::WriteSource` succeeded: a 3,115-byte synthetic HEIC decoded through WPF `BitmapDecoder` as one 64×48 Bgr32 frame. This validates only the small-image encode/decode path on this host.

A synthetic primary-item `irot` fixture was then added for an application-level check. With the rotation property present, WIC reports the expected 48×64 frame size, but `CopyPixels` fails with `0xC00D36BE` (`WINCODEC_ERR_UNSUPPORTEDOPERATION`) on this machine. The helper now removes the primary item's `irot` association from a private temporary copy, decodes the original pixels through WIC, applies the quarter-turn itself, and removes the temporary input on process exit. The local Electron test imports baseline, 90°, 180°, and 270° variants offline and compares decoded JPEG pixels against the corresponding orientation mapping; all four pass on this host. The 180°/270° variants are made by changing the `irot` value in a synthetic fixture at test runtime. This validates all three non-zero quarter-turn values in the application path, not real iPhone orientation metadata, grid layout, or codec behavior on another machine.

The offline Electron editor flow also checks a tiny HEIC whose primary `ispe` declares more than 64 MP and a truncated HEIC. With the freshly built native helper, both show the per-file decode reason, skip only the invalid HEIC, and persist the valid JPEG selected after it. The editor E2E file passes 7/7 locally. These synthetic negative fixtures do not establish behavior for real iPhone files or machines with different codec states.

A separate CC0 synthetic Display P3 HEIC fixture was generated from the public [ICC Display P3 encoding definition](https://registry.color.org/rgb-registry/displayp3), using a test-owned profile rather than Apple's profile binary. WIC reports one embedded profile. The helper initially preserved the encoded P3 sample (`230, 80, 30`) instead of converting it; the new WIC color-transform path stores an sRGB JPEG sample (`235, 47, 20`) closer to the ICC reference (`249, 61, 0`). A direct helper E2E and the actual offline Electron editor import both pass on this host, including light/dark screenshots. The observed WIC transform differs from the LittleCMS reference by up to 20 channel values for this synthetic patch; this is not a real iPhone color-accuracy result.

Separate WIC performance probes generated deterministic synthetic 12 MP and 48 MP HEIC files. On this host, five WPF `BitmapDecoder` samples for 12 MP had a median of 1,655.67 ms and nearest-rank IQR of 68.54 ms. Three native C++ WIC decode samples for 48 MP had a median of 3,031.63 ms and nearest-rank IQR of 190.73 ms; the largest whole-process peak working set was about 456.6 MiB. The 12 MP memory figures were also whole-process observations, not isolated decoder allocations. These measurements are not packaged-helper or iPhone-photo performance results.

Follow-up large-image measurement (2026-10-30): task-local `heif-enc` 1.21.2 encoded deterministic synthetic 16-bit RGB gradient/noise inputs as 10-bit, 4:2:0 HEIC (`-b 10 -q 45 -p preset=ultrafast`); `heif-info` confirmed 4032×3024 and 8064×6048 at 10 bits. Five fresh `h0-wic-decode.exe` processes per size measured WIC decoder creation, frame retrieval, BGRA32 conversion setup, and full `CopyPixels`; peak working set is the whole probe process. For 12 MP, elapsed median was 598.09 ms (range 461.06–927.14 ms; MAD 129.61 ms), with median peak working set 452.8 MiB (range 319.7–453.0 MiB; MAD 0.3 MiB). For 48 MP, elapsed median was 2794.24 ms (range 2516.97–2910.96 ms; MAD 116.72 ms), with median peak working set 1410.5 MiB (range 1410.4–1410.6 MiB; MAD <0.1 MiB). The HEIC files were 2.84 MB and 5.74 MB. The high 48 MP peak was not isolated to the packaged helper or explained; these synthetic measurements characterize only this host's WIC path, not a real iPhone image or packaged-app performance.

The synthetic 2×2 tiled HEIC now decodes through the native helper and editor; the test checks the complete dimensions and all four tile colors. A separate scratch WIC probe encoded two top-level HEVC still-image items with distinct colors: after changing `pitm` from item 1 to item 2, WIC `GetFrame(0)` returned item 2 and `GetFrame(1)` returned item 1 on this host (Windows 11 build 26300 with HEIF 1.2.62.0 and HEVC 2.5.48.0). This verifies primary-item ordering for this synthetic WIC file only; actual iPhone burst/auxiliary layouts and other Windows versions remain unverified. A synthetic Main10 fixture also decodes through the helper, but HDR PQ/HLG appearance and real iPhone photos remain unverified. The missing-extension HRESULT and Windows 10 baseline are still unmeasured. A follow-up in the actual Electron 44.7.0 / Chromium 152.0.7977.130 renderer supplied the synthetic `.heic` through Playwright to `<input accept="image/*">`; Chromium reported an empty `File.type`. A separate visible probe opened the native Windows picker for the same input: its image filter included `.heic` and it displayed the 64×48, 12 MP, and 48 MP project synthetic fixtures. No file was selected. This verifies picker visibility on this host only. No codec was installed or removed. The extension inventory and WIC registration do not establish whether Windows 11 24H2 ships either extension by default.

The Windows CI job records its HEIF/HEVC AppX inventory in the GitHub Actions step summary, using an all-users query with a current-user fallback if access is denied. Hosted run `41033601813` observed no installed HEIF or HEVC package on its `windows-latest` runner. This is one runner inventory result and does not establish Windows 11's default extension availability.

The desktop decoder does not tone-map HDR PQ/HLG. HDR visual output remains untested.

The Microsoft Store listings verified for the user-facing install guidance are [HEIF Image Extension](https://apps.microsoft.com/detail/9pmmsr1cgpwg) and [HEVC Video Extensions from Device Manufacturer](https://apps.microsoft.com/detail/9n4wgh0z6vhq). The paid [HEVC Video Extensions](https://apps.microsoft.com/detail/9nmzlz57r3t7) listing is separate. The user's Store availability and regional behavior were not tested.

Run the shell smoke test after `npm run build:electron` with `npm run test:e2e:electron -- --project=ci shell.spec.ts`. The fixture checks renderer isolation, navigation, single-instance focus, and loopback WebSocket, HTTPS Range and streamed responses. Its loopback certificate and private key are public test fixtures, never production credentials. Real-server `wss://` coverage belongs to the Diagnostics collaboration-ticket checks in the later integration tasks.

Development-only `OI_USER_DATA_DIR`, `OI_RENDERER_ROOT`, `OI_E2E_HEIC_HELPER`, and `OI_E2E_NO_HEIC_DECODER` overrides are ignored before access in packaged builds. Chromium's own `--user-data-dir` switch is separate from these test overrides.

### Measured facts (2026-10-27)

| Item | Value | How it was checked |
|---|---|---|
| Electron (pinned, no `^`) | 44.7.0 | `npm view electron@44.7.0 version`; the registry's latest was 45.0.0 |
| Runtime inside Electron 44.7.0 | Node 24.21.0, Chromium 152.0.7977.130, `NODE_MODULE_VERSION` 149, N-API 10 | `process.versions` printed from the main process |
| esbuild (pinned) | 0.28.2 | `npm view esbuild version`; `target` is `node24`, the Node major above |
| `better-sqlite3-multiple-ciphers` | 13.0.3, engines `node >=22` | `npm view`; tarball unpacked with `npm pack` |
| Its prebuilds | `win32-x64.node` and `win32-arm64.node` are both present, plus darwin, linux and linuxmusl | `prebuilds/` listing in the tarball |
| `electron-builder` / `electron-updater` | 26.15.3 and 6.8.9 exist; the registry's latest is 26.18.0 and 6.8.11 | `npm view`; neither is a dependency yet |
| `@playwright/test`, `@electron/fuses` | latest 1.64.1 and 2.1.3 | `npm view`; not dependencies yet |
| Electron upstream Windows floor | Windows 10 or later for Electron v23.0.0 and higher | [Electron breaking changes](https://www.electronjs.org/docs/latest/breaking-changes) |

InspectorHub's pilot support target is Windows 10 22H2 or later, or Windows 11, on `x64`; the first packaged build targets `x64`. This client is only tested on Windows 11 and on the `windows-latest` CI image. An `arm64` machine runs the x64 build under Windows 11's x64 emulation. A native `arm64` build is possible later because the database module ships a `win32-arm64` prebuild.

## Memory

Gradle, the Android emulator and the engine's type-checks are all memory hungry. On a 16 GB machine, do not run a Gradle build and a full type-check of the engine at the same time.

## Trying the version states on a device

The app reads the server's version policy (`GET /api/client/compat`) when a signed-in session starts and each time it returns to the
foreground. To see each state, point the app at a local engine and change that engine's settings:

| State | How to trigger it |
|---|---|
| Update available (dismissible banner, shown once per app version) | Set `NATIVE_RECOMMENDED_VERSION_ANDROID` (or `_IOS`) above the app version, restart the engine, bring the app to the foreground. |
| Update required (editing off, uploads continue) | Set `NATIVE_MIN_VERSION_ANDROID` above the app version. Set `NATIVE_DOWNLOAD_URL_ANDROID` to an https address to get the button. |
| Server version too old (nothing syncs, local work continues; editor writes answer that the server is too old) | Build the app with a higher `MIN_SERVER_CONTRACT_VERSION` in `src/auth/server-config.ts` than the engine's `SERVER_CONTRACT_VERSION`. |
| Server without the check for removed inspections (a notice, and that one check is skipped; everything else syncs) | Point the app at an engine whose `SERVER_CONTRACT_VERSION` is below `MIN_CONTRACT_FOR_RECONCILE` in `src/auth/server-config.ts` (or temporarily raise that constant above the engine's). The notice shows once per server and can be dismissed. |
| Test build expiry (iOS only) | Build with `APP_BUILT_AT` set to a UTC ISO instant 76 or more days ago, for example `APP_BUILT_AT=2026-07-01T00:00:00.000Z npm run build`. The warning only ever shows on iOS builds, and also on the lock, sign-in and server screens. |

## The inspection editor

The editor is `@inspectorhub/field-ui` (pinned to the `0.4` line in `package.json`), mounted by `src/ui/EditorScreen.tsx` over the device's own
data source. Tapping a row of the work list opens it. Its styles come from the package: `src/styles.css` imports `@inspectorhub/field-ui/theme.css`
and points Tailwind's `@source` at the package build, and Vite resolves the two third-party stylesheets the package imports. Check on a device:

| Area | How to check it |
|---|---|
| Back key | With a dialog or drawer open, back closes it; with none open, back returns to the work list; only on the work list does back leave the app. |
| Read-only | With an update required (see above) the editor shows a notice; commands, uploads and media saves are refused with "Editing is turned off until you update the app.". The editor is read-only (field-ui `readOnly`): no edits to the shared document, no host writes, write controls hidden; the data source's refusal stays as a second guard. |
| Removed inspection | Remove or quarantine the open inspection from another session and reconcile: the editor leaves for the list. |

## Trying Settings and the platform details on a device

Open Settings from the work list. Check each of these in the light and the dark scheme, on a phone and a tablet width, at font scale 1.3 and with
"Remove animations" on:

| Area | How to check it |
|---|---|
| Sync window | Choose 7, 30, then 14 days: one download starts per change, nothing disappears from the list, the choice survives a restart. |
| Back key and gesture | From Settings: a dialog closes first, then Settings returns to the list, then the app exits. On the server-address check and on a sign-in reached from the lock screen, back returns one step. |
| Notification question | On Android 13 or later, with a fresh install and one photo waiting to upload (offline), our explanation appears once; "Allow notifications" shows the system prompt; "Not now" never asks again and Settings shows the state. Turning notifications off in Android Settings and coming back updates the Notifications section. |
| Pull to refresh | At the top of the work list, drag down with one finger: the same download as the button. A drag that starts lower down only scrolls. |
| Haptics | A short vibration on the destructive confirmations, on a finished export and on signing out. |
| Open source | "Source code" and "Read the licence" open in the browser; the version and build date are shown. |
| Delete account | The row appears only when the server's compat answer carries an `accountUrl` (https). |

## End-to-end flows with Maestro

`maestro/` holds the device flows. They cover the screens that exist in this build: server setup and sign-in, the work list and its "Needs attention" panel, Settings (including "Photos not attached"), and the lock screen's two-step clear. They do not yet cover the inspection editor or the import entry; add flows for those when the device checks above have been done by hand.

| Flow | What it does |
|---|---|
| `01-sign-in.yaml` | Fresh install: enters the server address, allows plain http (debug builds only), connects, signs in on the engine's login page. |
| `02-seed-and-needs-attention.yaml` | Seeds demo rows from the development Diagnostics screen ("Seed demo data"), turns the network off, restarts the app and checks the work list and "Needs attention". |
| `03-settings-photos-not-attached.yaml` | Opens Settings and checks the "Photos not attached" section and its "Check again" button. |
| `04-lock-two-step-clear.yaml` | With the clock moved past the offline limit: the lock screen, then "Clear local data" asked twice, cancelled once and confirmed once. |

The flows depend on each other and must run in this order. `maestro/run-emulator.ps1` runs them and moves the emulator's clock for the last one (an emulator image without Play Store, so `adb root` works; the script always switches automatic date and time back on).

Run them against the emulator and a local engine:

1. Start the engine from your OpenInspection checkout with `NATIVE_CLIENT_ENABLED=1` in `.dev.vars` (port 8787) and have an account that can sign in without two-step verification.
2. Start the emulator (one at a time; it needs 2-4 GB, so never together with a Gradle build or an engine type-check) and install the debug build: `cap sync android`, `assembleDebug`, `adb install -r`.
3. In a PowerShell session:

```powershell
. .\scripts\dev-env.ps1
$env:OI_E2E_EMAIL = '<account on the local engine>'
$env:OI_E2E_PASSWORD = '<its password>'
.\maestro\run-emulator.ps1
```

The script runs `adb reverse tcp:8787 tcp:8787`, checks `http://localhost:8787/status`, and passes the account to Maestro as `-e` values. The account is read from the environment only; never put it in a flow or a file. A single flow can be run by hand with `maestro test -e SERVER_URL=http://localhost:8787 -e E2E_EMAIL=... -e E2E_PASSWORD=... maestro/01-sign-in.yaml`.

Notes from running them on the emulator: the runner pins adb and Maestro to the emulator, so a phone plugged in at the same time is left alone. The first sign-in after wiping the browser's data shows Chrome's first-run screen; dismiss it once by hand ("Use without an account"). The browser keeps the engine session between runs, so on later runs sign-in goes straight to the "Allow" page. In the Diagnostics page the WebView's accessibility bounds for elements far down the page do not match where they are drawn, so flow 02 brings "Seed demo data" into view with one slow swipe from the top of the page and taps it by screen position. If the emulator shows "System UI isn't responding" (low host memory), tap Wait and run the flow again.

The flows wait for elements to appear (`extendedWaitUntil`, `scrollUntilVisible`); none sleeps. A full run takes a few minutes once the emulator is up. Maestro needs JDK 21 (set by `dev-env.ps1`).

These flows are not run in CI: the CI jobs have no emulator. `npm test` runs `src/maestro-flows.test.ts`, which checks that every flow is well formed, that each text it taps or waits for still exists in the app, and that no flow holds a credential. It does not run Maestro. The email, password and authorize strings come from the engine's own pages and are listed in that test.

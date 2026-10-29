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

The desktop client lives in `electron/` (main process, preload script, shared IPC types) and reuses the same `src/` app as Android.

```
npm run build:electron
npx electron dist-electron/main/index.cjs
```

`build:electron` bundles the main process and preload script to CommonJS with esbuild. `npm run typecheck` checks `src/` and `electron/` with separate tsconfigs, so Node and DOM types never mix.

Import boundaries, enforced by `src/electron-boundaries.test.ts`:

- Code in `src/` outside `src/desktop/` never imports `electron`.
- `src/desktop/` reaches the main-process directory only through `electron/shared/`.
- `electron/` imports only a short allowlist of pure `src` modules (database, schema, path helpers, callback constants, media types).

The local database uses `better-sqlite3-multiple-ciphers`, which ships prebuilt binaries for Electron's N-API ABI; no native compiler is needed.

The desktop shell serves local renderer files from `https://localhost`. Its page, script, and Worker responses share one strict CSP, including in development: neither `unsafe-eval` nor `wasm-unsafe-eval` is allowed. An earlier plan relaxed the Worker policy for a bundled WASM HEIC decoder. The 2026-10-27 revision moved decoding to a main-process system helper and removed that relaxation entirely. A future bundled decoder (L2) must revisit this decision together with the CSP tests.

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

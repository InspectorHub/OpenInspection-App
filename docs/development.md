# Development

This page covers the local setup for Android and Windows (Electron). iOS is documented separately.

## Prerequisites

| Tool | Version | Note |
|---|---|---|
| Node.js | 22+ | Capacitor 8 requires it |
| JDK | 21 | Used only through `scripts/dev-env.ps1`; your global `JAVA_HOME` is not changed |
| Maestro | 2.11+ | End-to-end flows; unzip the release to a directory of your choice and put its `bin` on PATH (`dev-env.ps1` does this for `D:\DevTools\maestro`) |
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

```
npm run dev:electron
```

The local database uses `better-sqlite3-multiple-ciphers`, which ships prebuilt binaries for Electron's N-API ABI; no native compiler is needed.

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

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

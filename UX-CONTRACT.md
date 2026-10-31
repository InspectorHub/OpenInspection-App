# OpenInspection Native Client UX Contract

This contract records only user-visible behavior verified in the native client. Business and server policy stays in the existing API and product sources.

## Business and design sources

| Area | Maintained source |
|---|---|
| Supported platforms and local development | `docs/development.md` |
| Server setup and sign-in interaction | `src/ui/ServerSetup.tsx`, `src/ui/SignIn.tsx` |
| Signed-in work list and Settings entry | `src/ui/SignedIn.tsx`, `src/ui/Settings.tsx` |
| Lock and local-data recovery | `src/ui/Locked.tsx`, `src/ui/ClearLocalDataControl.tsx` |
| Electron bridge and renderer origin | `electron/shared/ipc-contract.ts`, `electron/main/app-origin.ts` |
| Task 12 desktop renderer decision | `.superpowers/sdd/plan-d2-windows-electron/task-12-brief.md` |

## Verified routes and flows

The app is a native single-window flow rather than a URL-routed website. A fresh install opens **Choose your server**. A valid server is reviewed before connection; sign-in opens the server's authorization page and returns to the app. A signed-in session opens the local work list. Settings is reached from that list and returns to it through its Back control. When the offline lock applies, the lock screen offers the existing sign-in and local-data recovery paths. See the source table above and the manual device flow in `docs/development.md`.

## Settings behavior

- Settings retains its current Sync, This device, Notifications, Photos not attached (when applicable), Your data, Account, and Open source sections.
- Capacitor/Android receives no desktop settings port, so the desktop section is absent there.
- Electron may receive the `DesktopSettingsPort` from `src/desktop/updater-port.ts`. That section shows the app version and a human-readable updater state, offers **Check for updates**, **Open log folder**, and **Open data folder**, and uses bridge methods rather than rendering local filesystem paths.
- When update state is disabled, the panel says exactly **Updates are turned off in this build** and the check action is disabled.
- The panel states exactly **Uploads continue only while InspectorHub is open.** This describes the desktop upload lifecycle selected in Plan D2 Task 12.

## Interaction rules

Use native buttons and labels with the shared field-ui theme and `src/ui/kit.tsx` variants. Preserve visible keyboard focus, disabled/busy state, and the established Settings heading hierarchy. The renderer is served from `https://localhost` under the Electron app's strict Content Security Policy; it accesses desktop facilities only through the validated preload bridge.

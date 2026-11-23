# OpenInspection App agent guide

This repository contains the offline-first native client for Android, iOS, and Windows.

## Commands

- `npm ci` installs the locked dependencies.
- `npm run typecheck` checks the renderer and Electron main process separately.
- `npm test` runs the Vitest suite.
- `npm run build` type-checks and builds the web client.
- `npm run check:bundle` checks the release bundle for development-only UI.
- `npm run test:docs-claims` tests the Markdown claim checker; `npm run lint:docs-claims` enforces its numeric baseline.
- `npm run api:types:check -- <contract-url-or-path>` checks generated API types against an engine contract.

CI is authoritative for the full platform matrix. Check [docs/development.md](docs/development.md) for local setup, Android, Windows, iOS, and platform-specific limitations. The root [README.md](README.md) is the product and documentation entry point.

## Boundaries

- Keep browser-rendered code in `src/` free of Node.js and Electron imports. Follow the import boundaries tested in `src/electron-boundaries.test.ts` and use the narrow preload bridge for desktop capabilities.
- Do not commit credentials, tokens, real user data, or machine-specific paths. Use synthetic test data and local environment files for machine-specific values.
- Preserve offline-first behavior and encrypted local storage. Treat import, export, sync, and deletion as data-sensitive paths; update their tests and user documentation when behavior changes.
- Keep generated API types in sync with the OpenInspection engine contract; edit their source generator or contract inputs rather than hand-editing generated output.
- Local SQLite schema changes go through the versioned `MIGRATIONS` list in `src/platform/schema.ts`. Keep versions contiguous; add a new version for post-release columns, and make statements safe to retry after an interrupted upgrade.
- The server address form uses an `onSubmit` handler. Programmatic submission must call `requestSubmit()`; `form.submit()` bypasses that handler.

## Documentation and changes

Update the relevant platform guide when setup, supported behavior, limitations, or user-facing workflows change. If documentation does not apply, explain why in the pull request. Markdown path and `npm run` references are checked by `lint:docs-claims`; reduce the baseline only when fixing existing stale claims.

Use the repository's existing test and review conventions. Pull requests should state user impact, verification performed, platform coverage, and documentation status. Do not publish, tag, or merge a release from an agent task.

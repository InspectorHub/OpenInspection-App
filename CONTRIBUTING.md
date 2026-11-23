# Contributing

Thanks for helping improve OpenInspection App. The project is an offline-first client for Android, iOS, and Windows, licensed under AGPL-3.0-only.

## Before opening a pull request

1. Read [README.md](README.md) and the relevant sections of [docs/development.md](docs/development.md).
2. Keep changes focused and include or update tests for changed behavior.
3. Run the checks relevant to your change. The standard local checks are:

   ```sh
   npm ci
   npm run typecheck
   npm test
   npm run build
   ```

   CI also checks release bundles, the engine API contract, and platform builds. Some checks need platform-specific tooling; say which checks you could not run.
4. Update user or developer documentation when behavior, setup, supported platforms, or limitations change. If no documentation applies, explain why in the pull request.
5. Use synthetic data in tests, screenshots, and issue attachments. Never include credentials, tokens, or real customer data.

## Code boundaries

- Renderer code must not import Node.js or Electron APIs. Desktop capabilities belong behind the narrow preload bridge.
- Keep the offline database and local secrets within their existing storage boundaries. Review import, export, sync, and deletion changes for data loss and recovery behavior.
- Change generated API types through their generator and verify against the engine contract when available.
- Keep pull request descriptions and repository content in English, and include no private operational or commercial material.

## Pull requests

Describe the problem, the user-visible effect, implementation summary, and checks run. Identify Android, iOS, and Windows coverage that applies. Complete the documentation item in the pull request template. A maintainer will review and coordinate release work.

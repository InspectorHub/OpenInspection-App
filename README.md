# OpenInspection App

The offline-first native client for [OpenInspection](https://github.com/InspectorHub/OpenInspection): a Capacitor app for Android and iOS (Electron for Windows follows). Inspectors capture data in the field without a network and sync when one is available.

- App ID: `io.inspectorhub.app`
- Stack: Vite, React 19, TypeScript, Capacitor 8
- API types are generated from the engine's `contracts/native-contract.openapi.json`

## Getting started

```
npm ci
npm run typecheck
npm test
npm run build
npm run cap:sync
```

Regenerate API types with `OPENINSPECTION_CONTRACT=<path or URL> npm run api:types`.

Local setup for Android and Windows is in [docs/development.md](docs/development.md). Cutting a release is in [docs/release.md](docs/release.md).

## License

AGPL-3.0. See [LICENSE](LICENSE).

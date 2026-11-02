# Keeping the fake engine and the real engine's contract in step

The golden flows (Android G2 to G4), the Electron end-to-end tests and several unit tests talk to a fake engine (`e2e/fake-engine`). It is hand-written, so it can fall behind the real engine. A flow that passes against a fake that no longer matches proves nothing about the real one. This page says what keeps them together and what does not.

## The contract

The real engine's contract is `contracts/native-contract.openapi.json` in the engine repository (`InspectorHub/OpenInspection`). It is generated from the engine's route definitions (`npm run native:contract`), not written by hand. These engine-side checks keep that file current. They were read from the engine's scripts and test headers, and were not run for this page:

- `tests/unit/native/contract-drift.spec.ts` regenerates the document and fails when the committed file is stale.
- `lint:native-contract` (push rung) checks that the registry of endpoints the native app calls and the committed file agree.
- CI diffs the file against the base branch with oasdiff.

## What this repository does with it

| Layer | Where | What it catches | When |
|---|---|---|---|
| Generated types | `src/api/schema.d.ts`, `npm run api:types:check` | The app's own client code against a changed contract | CI `verify`, against the engine's `main` |
| Offline command snapshot | `src/offline/test-support/native-contract.snapshot.json`, `src/offline/registry.test.ts` | A registered offline command whose method, route or payload no longer matches (3 routes) | unit tests |
| Fake engine, compile time | `contract<'/path', 'get'>()` in `e2e/fake-engine/engine.ts` | The SHAPE of a fake answer against the contract's response type: a field added, renamed or made required fails `npm run typecheck` | typecheck |
| Fake engine, run time | `e2e/fake-engine/contract.test.ts` | The VALUES: the fake is started, 18 routes are asked, and each answer is validated with Ajv against the contract's own JSON schema | CI `verify` (required), or by hand |

Run the run-time check by hand with a copy of the contract or its URL:

```
OPENINSPECTION_CONTRACT=../OpenInspection/contracts/native-contract.openapi.json npx vitest run e2e/fake-engine/contract.test.ts
```

Without the variable the check is skipped, and the skip is visible in the test output. CI sets `REQUIRE_ENGINE_CONTRACT=1`: then a missing or unreadable contract, or fewer checked routes than probed, is a failure. The contract is fetched with three tries, so a hiccup of the host does not fail a pull request; an engine `main` whose contract changed does fail it, until the fake follows. The test has controls (a body that breaks the contract must be reported, for the session, the session context and report-data), and prints how many routes it probed and how many matched.

## What is NOT covered

- `POST /api/inspections/{id}/cover` is bound at compile time only; it needs an earlier upload and a multipart body.
- The sign-in protocol (`/oauth/authorize`, `/oauth/register`, `/oauth/token`), the token-addressed upload (`POST /api/public/uploads/photo`) and the photo bytes (`GET /api/inspections/{id}/photo`) are not in the OpenAPI contract at all. Nothing compares the fake's behaviour there with the real engine's.
- The Electron specs seed some answers of their own (`e2e-electron/fixtures/desktop-harness.ts`, `photo-import.spec.ts`, `heic-editor.local.spec.ts`: a hand-written `/api/session/context` and inspection body). Those are neither type-bound nor checked at run time.
- Only success bodies are checked. The fake's error answers (401, 400, 413 and so on) are not compared with the contract.
- Behaviour is not checked, only answers: the fake does not enforce what the real engine enforces (roles, rate limits, ordering).
- A contract can be incomplete. The check cannot see a field the real handler returns but the contract does not list.

## Fields the fake sends that the contract does not list

- `GET /api/inspections/{id}`: `propertyType` and `reportStatus` on the inspection, because the app reads them (`src/field/editor-data.ts`).
- `GET /api/inspections/{id}/report-data`: `type: 'rich'` on every item, because `buildSchema` (`src/field/loader-schema.ts`) uses these sections instead of the template's, and the editor shows the rating row only for `rich` items.

The contract lists none of these, **and the real engine does return all three** (checked 2026-11-02 against engine commit `e9fc7a5b`):

- Code: the handler of `GET /api/inspections/{id}` (`server/api/inspections/core.ts`) answers with the whole `inspections` row (`...result`), and `propertyType` and `reportStatus` are columns of that table (`server/lib/db/schema/inspection/core.ts`). The report-data service builds every item with `type: item.type ?? 'rich'` (`server/services/inspection/inspection-report.service.ts`), and the route returns that result as it is. Neither route validates its answer against the response schema.
- Run time: a throwaway probe in the engine's own unit-test setup (real `InspectionService`, the real table definitions over an in-memory database; not committed) asked for an inspection with `property_type = single_family` and a template item with no type. `getInspection` returned `propertyType: "single_family"` and `reportStatus: "in_progress"`; `getReportData` returned an item with `type: "rich"`. The probe ran the service layer, not the HTTP route, so the route's own steps (the money projection, the readable-snapshot step) were not exercised; the code shows they do not remove these fields.

So the contract under-documents these answers: the item in `report-data` also carries, among others, `parentId`, `ratingOptions`, `tabs`, `naKind`, `notInspectedReason`, `value` and `resolvedTabs`, none of which the contract lists. The app is not reading fields that are absent. The cost is that a change to any of them reaches the app with no contract diff to warn about it. Documenting them is a change to the engine's response schemas (and a regenerated contract), which belongs in the engine repository.

## When the engine changes its contract

1. `npm run api:types` regenerates `src/api/schema.d.ts`. Commit it.
2. `npm run typecheck` shows every fake answer that no longer fits. Change the fake, not the type.
3. Run the run-time check above. It catches what the types cannot: a null where the contract says absent, a missing required value inside a loosely typed object.
4. If a route the offline registry replays changed, `npm run contract:fixture` and `src/offline/registry.test.ts`.

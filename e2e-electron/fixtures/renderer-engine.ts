// The engine itself lives in e2e/fake-engine/ so Android and iOS tests can run it standalone (see docs/development.md).
// This module keeps the API every Electron spec already imports.
export { startRendererEngine, type RendererEngine, type RendererEngineOptions } from '../../e2e/fake-engine/engine.ts';

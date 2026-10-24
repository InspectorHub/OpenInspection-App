import { createSignedInWorld, createWorld, type World } from '../app/test-support/world';
import type { AppServices } from '../app/compose';
import { createManualTimers, type ManualTimers } from '../collab/test-support/manual-timers';
import { createFakeEngine, createFakePlugin, type FakeEngine, type FakePlugin } from '../media/test-support/fakes';
import type { Network } from '../platform/network';
import type { CheckResult, DiagContext, DiagDeps, DiagPorts, SocketProbe } from './checks/types';

export interface DiagRig {
  world: World;
  services: AppServices;
  ctx: DiagContext;
  deps: DiagDeps;
  ports: DiagPorts & { images: string[]; sockets: string[]; socketProbe: SocketProbe; imageLoads: boolean };
  plugin: FakePlugin;
  engine: FakeEngine;
  timers: ManualTimers;
  emitted: CheckResult[];
}

export interface DiagRigOptions {
  signedIn?: boolean;
  inspectionId?: string;
  /** Replaces the world's database/files wiring, for failure paths. */
  wrap?: (services: AppServices) => AppServices;
}

const ONLINE: Network = { online: () => Promise.resolve(true), onChange: () => () => undefined };

/** A device made of fakes: sql.js, in-memory files, the fake engine and uploader plugin, manual timers. */
export async function createDiagRig(options: DiagRigOptions = {}): Promise<DiagRig> {
  const signedIn = options.signedIn ?? true;
  const world = signedIn ? await createSignedInWorld() : await createWorld();
  const engine = createFakeEngine();
  const plugin = createFakePlugin({ engine, files: world.files });
  const timers = createManualTimers();
  let serial = 0;
  const ports: DiagRig['ports'] = {
    images: [],
    sockets: [],
    socketProbe: { opened: false, closeCode: 1006, threw: null },
    imageLoads: true,
    statMissing: () => Promise.resolve({ code: 'OS-PLUG-FILE-0008', message: 'File does not exist: media/diag-missing.jpg' }),
    loadImage: (url) => {
      ports.images.push(url);
      return Promise.resolve(ports.imageLoads);
    },
    storageEstimate: () => Promise.resolve({ usage: 1024 * 1024, quota: 101 * 1024 * 1024 }),
    notificationPermission: () => 'default',
    probeSocket: (url) => {
      ports.sockets.push(url);
      return Promise.resolve(ports.socketProbe);
    },
    timers,
    random: () => {
      serial += 1;
      return (serial * 0.137) % 1;
    },
  };
  const deps: DiagDeps = { ports, uploaderPlugin: plugin, network: ONLINE };
  const base: AppServices = { ...world.services, http: signedIn ? engine.http : world.services.http };
  const services = options.wrap ? options.wrap(base) : base;
  const emitted: CheckResult[] = [];
  const ctx: DiagContext = {
    services,
    origin: signedIn ? world.server.origin : null,
    inspectionId: options.inspectionId ?? 'insp-1',
    deps,
    emit: (result) => emitted.push(result),
  };
  return { world, services, ctx, deps, ports, plugin, engine, timers, emitted };
}

export async function rowsFor(services: AppServices, table: 'ydoc_updates' | 'media' | 'device_state', where: string, param: string): Promise<number> {
  const rows = await services.db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where} = ?`, [param]);
  return Number(rows[0]?.n);
}

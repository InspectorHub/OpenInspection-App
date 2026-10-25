import type { VideoUploadTicket } from '@inspectorhub/field-ui';
import { createMediaWorld, INSPECTION, ORIGIN, TENANT, type MediaWorld } from '../../media/test-support/fakes';
import type { ApiOutcome } from '../api-client';
import { reply, scriptedApi } from './scripted-api';
import { createVideoAdapter, type VideoAdapterDeps } from '../video-adapter';

export const SESSION_OK = { kind: 'ok', session: { userId: 'u', tenantId: 't', role: 'inspector', offlineMaxDays: 7 } } as const;
export const TOKEN = 'vtoken0001.vsignature0001';
export const R2_KEY = `${TENANT}/inspections/${INSPECTION}/videos/m1.mp4`;
export const clip = (type = 'video/mp4', bytes = 96): File => new File([new Uint8Array(bytes).fill(5)], 'clip.mp4', { type });

export function ticketAnswer(over: Record<string, unknown> = {}): ApiOutcome {
  return reply(200, {
    success: true,
    data: { uploadURL: `https://public.example.com/api/public/uploads/video?token=${TOKEN}`, provider: 'r2', ref: { provider: 'r2', mediaId: 'm1', r2Key: R2_KEY }, ...over },
  });
}

export async function setup(options: { online?: boolean; provider?: 'r2' | 'stream'; answers?: ApiOutcome[]; world?: MediaWorld } = {}) {
  const world = options.world ?? (await createMediaWorld());
  const api = scriptedApi(...(options.answers ?? []));
  const state = { online: options.online ?? true, provider: options.provider ?? ('r2' as 'r2' | 'stream'), blocked: false };
  let ids = 0;
  const deps: VideoAdapterDeps = {
    api,
    store: world.store,
    isBlocked: () => Promise.resolve(state.blocked),
    isOnline: () => state.online,
    videoProvider: () => state.provider,
    origin: ORIGIN,
    clock: { now: () => 5000 },
    newId: () => `id${String((ids += 1))}`,
  };
  return { world, api, state, adapter: createVideoAdapter(deps), deps };
}

export const need = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error('missing');
  return value;
};

export type { VideoUploadTicket };

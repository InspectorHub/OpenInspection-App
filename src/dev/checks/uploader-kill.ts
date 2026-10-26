import { paddedJpegBytes } from '../jpeg';
import { buildRig, createDiagStore, diagCounts, removeAllDiagMedia, DIAG_PREFIX, type MediaRig } from './media-rig';
import { fail, guarded, needsInput, needsSignIn, pass, type CheckResult, type DiagContext, type ExtraDef } from './types';

export const KILL_PHOTOS = 20;
const KILL_PHOTO_BYTES = 4 * 1024 * 1024;
const KILL_PREFIX = `${DIAG_PREFIX}kill-`;
const POLL_MS = 1000;

const startDef = { id: 'kill-start', title: '[diag] kill-start: twenty photos uploading, to be interrupted' };
const resumeDef = { id: 'kill-resume', title: '[diag] kill-resume: reconcile what an interrupted run left behind' };
const cleanDef = { id: 'kill-clean', title: '[diag] kill-clean: remove every diagnostic photo row and file' };

interface Session {
  rig: MediaRig;
  stopPolling(): void;
}

/** The running kill test of this page, if any. The page can hold at most one. */
let session: Session | null = null;

async function endSession(): Promise<void> {
  const current = session;
  session = null;
  if (!current) return;
  current.stopPolling();
  await current.rig.dispose().catch(() => undefined);
}

function countText(counts: Awaited<ReturnType<typeof diagCounts>>): string {
  return `left=${String(counts.total)} pending=${String(counts.pending)} uploading=${String(counts.uploading)} uploaded=${String(counts.uploaded)} failed=${String(counts.failed)}`;
}

export const killStart: ExtraDef = {
  ...startDef,
  parent: 'uploader-photo',
  label: 'Start kill test',
  hint: `Stores ${String(KILL_PHOTOS)} photos of 4 MiB and uploads them one at a time. Force-stop the app while the counter runs, open it again and press "Resume diag uploads".`,
  run: (ctx) =>
    guarded(startDef, async () => {
      if (ctx.origin === null) return needsSignIn(startDef);
      if (ctx.inspectionId === '') return needsInput(startDef);
      await endSession();
      const { services } = ctx;
      await removeAllDiagMedia(createDiagStore(ctx));
      const rig = buildRig(ctx, { concurrency: 1 });
      const now = services.clock.now();
      const bytes = paddedJpegBytes(KILL_PHOTO_BYTES);
      for (let i = 0; i < KILL_PHOTOS; i += 1) {
        await rig.store.put({
          pendingId: `${KILL_PREFIX}${String(i).padStart(2, '0')}`,
          inspectionId: ctx.inspectionId,
          kind: 'photo',
          blob: new Blob([bytes], { type: 'image/jpeg' }),
          createdAt: now + i,
          meta: { targetType: 'item', findingKey: '_default:diag:diag', itemId: 'diag' },
        });
      }

      let polling = true;
      let handle: unknown = null;
      const emit = (text: string): void => {
        const result: CheckResult = { id: startDef.id, title: startDef.title, ok: true, status: 'pass', detail: text };
        ctx.emit(result);
      };
      const tick = async (): Promise<void> => {
        if (!polling) return;
        try {
          const counts = await diagCounts(rig.store);
          emit(`kill=${counts.total === 0 ? 'finished' : 'running'} done=${String(KILL_PHOTOS - counts.total)} of=${String(KILL_PHOTOS)} ${countText(counts)} native_started=${String(rig.observed.starts)}`);
          if (counts.total === 0) {
            polling = false;
            return;
          }
        } catch {
          emit('kill=counter_error');
        }
        if (polling) handle = ctx.deps.ports.timers.setTimeout(() => void tick(), POLL_MS);
      };
      session = {
        rig,
        stopPolling: () => {
          polling = false;
          if (handle !== null) ctx.deps.ports.timers.clearTimeout(handle);
        },
      };
      rig.reconciler.start();
      handle = ctx.deps.ports.timers.setTimeout(() => void tick(), POLL_MS);
      return pass(startDef, `kill=started photos=${String(KILL_PHOTOS)} mib_each=4 concurrency=1 next=force_stop_then_reopen_then_resume`);
    }),
};

export const killResume: ExtraDef = {
  ...resumeDef,
  parent: 'uploader-photo',
  label: 'Resume diag uploads',
  hint: 'Run this after the app was force-stopped and opened again. It reconciles the leftover diag photos and prints how they ended.',
  run: (ctx: DiagContext) =>
    guarded(resumeDef, async () => {
      if (ctx.origin === null) return needsSignIn(resumeDef);
      await endSession();
      const rig = buildRig(ctx, { concurrency: 3 });
      try {
        const before = await diagCounts(rig.store);
        const run = await rig.reconciler.reconcileUploads();
        const after = await diagCounts(rig.store);
        const summary = `resume before_total=${String(before.total)} before_uploading=${String(before.uploading)} retried=${String(run.retried)} confirmed=${String(run.confirmed)} ${countText(after)} native_started=${String(rig.observed.starts)} errors=${String(rig.observed.errors)}`;
        return after.failed === 0 ? pass(resumeDef, summary) : fail(resumeDef, summary);
      } finally {
        await rig.dispose().catch(() => undefined);
      }
    }),
};

export const killClean: ExtraDef = {
  ...cleanDef,
  parent: 'uploader-photo',
  label: 'Remove diag uploads',
  hint: 'Deletes every diag- photo row and its file from the device.',
  run: (ctx) =>
    guarded(cleanDef, async () => {
      await endSession();
      const removed = await removeAllDiagMedia(createDiagStore(ctx));
      const left = await diagCounts(createDiagStore(ctx));
      const summary = `removed=${String(removed)} left=${String(left.total)}`;
      return left.total === 0 ? pass(cleanDef, summary) : fail(cleanDef, summary);
    }),
};

/** Stops the running kill test without touching rows (the screen calls this when it closes). */
export function stopKillSession(): Promise<void> {
  return endSession();
}

import { paddedJpegBytes } from '../jpeg';
import { createDiagStore, diagCounts, DIAG_PREFIX } from './media-rig';
import { fail, guarded, needsInput, needsSignIn, pass, type DiagContext, type ExtraDef } from './types';

export const DESKTOP_KILL_PHOTOS = 50;
const PHOTO_BYTES = 64 * 1024;
const PREFIX = `${DIAG_PREFIX}e2e-kill-`;
const POLL_MS = 250;
const startDef = { id: 'desktop-kill-start', title: '[diag] desktop-kill-start: fifty photos uploading, to be interrupted' };
const resumeDef = { id: 'desktop-kill-resume', title: '[diag] desktop-kill-resume: reconcile the interrupted fifty-photo run' };

interface Session { stopPolling(): void; }
let session: Session | null = null;

async function endSession(): Promise<void> {
  const current = session;
  session = null;
  if (!current) return;
  current.stopPolling();
}

async function removeRunRows(ctx: DiagContext): Promise<void> {
  const store = createDiagStore(ctx);
  const rows = await store.listRows({ states: ['pending', 'uploading', 'uploaded', 'failed'] });
  for (const row of rows) if (row.pendingId.startsWith(PREFIX)) await store.delete(row.pendingId);
}

export const desktopKillStart: ExtraDef = {
  ...startDef,
  parent: 'uploader-photo',
  label: 'Start 50-photo restart test',
  hint: 'Queues 50 diagnostic JPEGs (64 KiB each). Force-stop the main process after the fake engine has received 10–40 unique keys, then reopen the app and run the resume action.',
  run: (ctx) => guarded(startDef, async () => {
    if (ctx.origin === null) return needsSignIn(startDef);
    if (ctx.inspectionId === '') return needsInput(startDef);
    await endSession();
    await removeRunRows(ctx);
    const store = createDiagStore(ctx);
    const now = ctx.services.clock.now();
    const bytes = paddedJpegBytes(PHOTO_BYTES);
    for (let i = 0; i < DESKTOP_KILL_PHOTOS; i += 1) {
      await store.put({
        pendingId: `${PREFIX}${String(i).padStart(2, '0')}`,
        inspectionId: ctx.inspectionId,
        kind: 'photo',
        blob: new Blob([bytes], { type: 'image/jpeg' }),
        createdAt: now + i,
        meta: { targetType: 'item', findingKey: '_default:diag:diag', itemId: 'diag' },
      });
      if ((i + 1) % 5 === 0) {
        ctx.emit({ id: startDef.id, title: startDef.title, ok: true, status: 'pass', detail: `queue=${String(i + 1)} of=${String(DESKTOP_KILL_PHOTOS)}` });
      }
    }

    let polling = true;
    let timer: unknown = null;
    const emit = (detail: string): void => ctx.emit({ id: startDef.id, title: startDef.title, ok: true, status: 'pass', detail });
    const tick = async (): Promise<void> => {
      if (!polling) return;
      try {
        const counts = await diagCounts(store);
        const done = counts.uploaded + (DESKTOP_KILL_PHOTOS - counts.total);
        emit(`kill=${counts.pending + counts.uploading === 0 ? 'finished' : 'running'} done=${String(done)} of=${String(DESKTOP_KILL_PHOTOS)} left=${String(counts.total)} pending=${String(counts.pending)} uploading=${String(counts.uploading)} uploaded=${String(counts.uploaded)} failed=${String(counts.failed)}`);
        if (counts.pending + counts.uploading === 0) { polling = false; return; }
      } catch { emit('kill=counter_error'); }
      if (polling) timer = ctx.deps.ports.timers.setTimeout(() => void tick(), POLL_MS);
    };
    session = { stopPolling: () => { polling = false; if (timer !== null) ctx.deps.ports.timers.clearTimeout(timer); } };
    timer = ctx.deps.ports.timers.setTimeout(() => void tick(), POLL_MS);
    return pass(startDef, `kill=started photos=${String(DESKTOP_KILL_PHOTOS)} kib_each=64 concurrency=1 next=force_stop_then_reopen_then_resume`);
  }),
};

export const desktopKillResume: ExtraDef = {
  ...resumeDef,
  parent: 'uploader-photo',
  label: 'Resume 50-photo restart test',
  hint: 'After force-stopping and reopening the desktop, wait for the signed-in app stack to resume all 50 uploads.',
  run: (ctx) => guarded(resumeDef, async () => {
    if (ctx.origin === null) return needsSignIn(resumeDef);
    await endSession();
    const store = createDiagStore(ctx);
    const before = await diagCounts(store);
    const deadline = Date.now() + 60_000;
    let after = before;
    while ((after.pending > 0 || after.uploading > 0) && after.failed === 0 && Date.now() < deadline) {
      await new Promise<void>((resolve) => ctx.deps.ports.timers.setTimeout(resolve, 500));
      after = await diagCounts(store);
    }
    const summary = `resume before_total=${String(before.total)} left=${String(after.total)} pending=${String(after.pending)} uploading=${String(after.uploading)} uploaded=${String(after.uploaded)} failed=${String(after.failed)} mode=app_stack`;
    const completedOrDeleted = after.uploaded + (DESKTOP_KILL_PHOTOS - after.total);
    const complete = after.pending === 0 && after.uploading === 0 && after.failed === 0 && completedOrDeleted >= DESKTOP_KILL_PHOTOS;
    if (!complete) return fail(resumeDef, summary);
    return pass(resumeDef, summary);
  }),
};

export function stopDesktopKillSession(): Promise<void> { return endSession(); }

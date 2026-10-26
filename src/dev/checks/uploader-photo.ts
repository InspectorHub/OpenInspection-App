import { isExpectedKey } from '../../media/native-uploader';
import { mediaPath } from '../../media/store';
import { tinyJpegBytes } from '../jpeg';
import { buildRig, DIAG_PREFIX } from './media-rig';
import { fail, guarded, needsInput, needsSignIn, pass, type CheckDef } from './types';

const def = { id: 'uploader-photo', title: '[diag] uploader-photo: one photo through the real uploader and reconciler' };

export function diagPendingId(random: () => number, middle = ''): string {
  return `${DIAG_PREFIX}${middle}${Math.floor(random() * 36 ** 8).toString(36).padStart(8, '0')}`;
}

export const uploaderPhoto: CheckDef = {
  ...def,
  hint: 'Stores a tiny JPEG under a diag- id, mints a signed url, uploads it with the native plugin, then lets the reconciler finish and delete it. One small object stays in the server storage.',
  run: (ctx) =>
    guarded(def, async () => {
      if (ctx.origin === null) return needsSignIn(def);
      if (ctx.inspectionId === '') return needsInput(def);
      const { services } = ctx;
      const started = services.clock.now();
      const rig = buildRig(ctx, { concurrency: 1 });
      const pendingId = diagPendingId(ctx.deps.ports.random);
      const inspectionId = ctx.inspectionId;
      try {
        await rig.store.put({
          pendingId,
          inspectionId,
          kind: 'photo',
          blob: new Blob([tinyJpegBytes()], { type: 'image/jpeg' }),
          createdAt: services.clock.now(),
          meta: { targetType: 'item', findingKey: '_default:diag:diag', itemId: 'diag' },
        });
        await rig.uploader.attach();
        const outcome = await rig.uploader.uploadDetailed({ pendingId, inspectionId });
        const row = await rig.store.getRow(pendingId);
        const last = rig.observed.events[rig.observed.events.length - 1];
        const eventText = last ? `event=${last.name} status=${last.statusCode === null ? 'none' : String(last.statusCode)}` : 'event=none';
        const mint = rig.observed.starts > 0 ? 'ok' : 'not_reached';
        if (!outcome.ok) {
          return fail(def, `mint=${mint} native_started=${String(rig.observed.starts)} ${eventText} upload=failed code=${outcome.code} retryable=${String(outcome.retryable)}`);
        }
        const keyShape = row !== null && isExpectedKey(outcome.key, row) ? 'ok' : 'unexpected';
        const state = row?.state ?? 'none';
        const reconciled = await rig.reconciler.reconcileUploads();
        const rowGone = (await rig.store.getRow(pendingId)) === null;
        const fileGone = !(await services.files.exists(mediaPath(pendingId, 'image/jpeg')));
        const summary = [
          `mint=${mint}`,
          `native_started=${String(rig.observed.starts)}`,
          eventText,
          `state=${state}`,
          `key_shape=${keyShape}`,
          `reconcile_confirmed=${String(reconciled.confirmed)}`,
          `row_removed=${rowGone ? 'yes' : 'no'}`,
          `file_removed=${fileGone ? 'yes' : 'no'}`,
          `errors=${String(rig.observed.errors)}`,
          `ms=${String(services.clock.now() - started)}`,
        ].join(' ');
        const good = mint === 'ok' && state === 'uploaded' && keyShape === 'ok' && reconciled.confirmed >= 1 && rowGone && fileGone;
        return good ? pass(def, summary) : fail(def, summary);
      } finally {
        await rig.store.delete(pendingId).catch(() => undefined);
        await rig.dispose().catch(() => undefined);
      }
    }),
};

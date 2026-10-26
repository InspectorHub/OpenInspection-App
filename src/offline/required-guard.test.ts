import { expect, it } from 'vitest';
import { createCollabConnector, type CollabConnectorDeps } from '../collab/connector';
import { createNativeUploader, type NativeUploaderDeps } from '../media/native-uploader';
import { createWithDoc, type WithDocDeps } from '../media/pending-doc';
import { createMediaReconciler, type ReconcileDeps } from '../media/reconcile';
import { createMediaStore, type MediaStoreDeps } from '../media/store';
import { createReplayer, type ReplayDeps } from './replay';

declare const connectorDeps: Omit<CollabConnectorDeps, 'isBlocked'>;
declare const storeDeps: Omit<MediaStoreDeps, 'isBlocked'>;
declare const uploaderDeps: Omit<NativeUploaderDeps, 'isBlocked'>;
declare const reconcilerDeps: Omit<ReconcileDeps, 'isBlocked'>;
declare const reconcilerWithoutDefectStep: Omit<ReconcileDeps, 'resolveDefectPhoto'>;
declare const withDocDeps: Omit<WithDocDeps, 'isBlocked'>;
declare const replayDeps: Omit<ReplayDeps, 'isBlocked'>;

/**
 * The data-layer guard is a REQUIRED dependency of every module that touches an inspection's data, so a composition root
 * that forgets to pass it does not compile. Each line below is an error the compiler must report; when `isBlocked` becomes
 * optional again, the matching directive is unused and `npm run typecheck` fails. The function is never called.
 */
export function omittingTheGuardDoesNotCompile(): void {
  // @ts-expect-error isBlocked is required
  createCollabConnector(connectorDeps);
  // @ts-expect-error isBlocked is required
  createMediaStore(storeDeps);
  // @ts-expect-error isBlocked is required
  createNativeUploader(uploaderDeps);
  // @ts-expect-error isBlocked is required
  createMediaReconciler(reconcilerDeps);
  // @ts-expect-error a photo row can be a defect photo, so its document step is required
  createMediaReconciler(reconcilerWithoutDefectStep);
  // @ts-expect-error isBlocked is required
  createWithDoc(withDocDeps);
  // @ts-expect-error isBlocked is required
  createReplayer(replayDeps);
}

it('the compile-time checks above are part of the type check; nothing runs here', () => {
  expect(typeof omittingTheGuardDoesNotCompile).toBe('function');
});

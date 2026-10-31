import * as Y from 'yjs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PendingMediaRecord } from '@inspectorhub/field-ui';
import { AuthError } from '../auth/errors';
import { createStackWorld } from '../app/test-support/stack-world';
import { photoRecord } from '../media/test-support/fakes';
import { installStrictGlobals, restoreGlobals } from '../test-support/strict-globals';
import { createStoredBlobReader, createUploaderFactory } from './uploader';
import { createForegroundUploads } from './uploader-foreground';
import { scriptedApi } from './test-support/scripted-api';

beforeEach(installStrictGlobals);
afterEach(restoreGlobals);

const ID = 'insp-1';
type Photo = Extract<PendingMediaRecord, { kind: 'photo' }>;

describe('a batch over the real stack while the server cannot be reached', () => {
  it('keeps every photo as a pending entry of the open document', async () => {
    const w = await createStackWorld();
    const down = { value: true };
    const stack = w.make({
      http: { request: (req) => (down.value && req.url.includes('/media/upload-url') ? Promise.reject(new AuthError('server_unreachable')) : w.pkg.http.request(req)) },
      editor: { liveDoc: (id) => (id === ID ? live.doc : null) },
    });
    const live = stack.connector.connect(ID, {});
    const api = scriptedApi();
    const factory = createUploaderFactory({
      isBlocked: () => Promise.resolve(false),
      store: stack.store,
      withDoc: stack.withDoc,
      native: stack.uploader,
      foreground: createForegroundUploads({ api, readStoredBlob: createStoredBlobReader(stack.store, w.files), isSynced: () => true }),
      onError: (error) => errors.push(error),
    });
    const errors: unknown[] = [];
    const recs: Photo[] = [1, 2, 3].map((n) => ({ ...photoRecord(`batch-${n}`, { inspectionId: ID, seed: n }) }));
    const uploader = factory(ID, live.doc);
    const results = await Promise.all(recs.map((rec) => uploader.upload(rec)));
    const photos = (live.doc.getMap<unknown>('results').get('_default:s1:i1') as Y.Map<unknown>).get('photos') as Y.Array<Y.Map<unknown>>;
    expect({ kept: results.map((r) => !r.ok && r.kept === true), entries: photos.toArray().map((p) => p.get('pendingId')), errors }).toEqual({
      kept: [true, true, true],
      entries: ['batch-1', 'batch-2', 'batch-3'],
      errors: [],
    });
    await stack.stop();
  });
});

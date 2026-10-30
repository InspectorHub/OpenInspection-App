// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FieldDataSource } from '@inspectorhub/field-ui';
import { editorObserver } from '../ui/editor-observer';
import { installEditorE2EState } from './editor-e2e-state';

type Put = (record: { blob: Blob }) => Promise<void>;

afterEach(() => {
  editorObserver.install(null);
  delete window.__oiE2EEditorState;
});

function observe(over: { online?: boolean; put?: Put } = {}) {
  installEditorE2EState();
  const probe = { isOnline: () => over.online ?? true, hasLiveDoc: () => false, readOnly: false };
  const observation = editorObserver.current()!(probe);
  const store = { put: vi.fn(over.put ?? (() => Promise.resolve())) };
  const source = { isOnline: () => over.online ?? true, media: { store } } as unknown as FieldDataSource;
  observation.attach(source);
  return { observation, source, store };
}

describe('the Electron end-to-end editor state', () => {
  it('publishes the probe, records what the editor says and the link state it read, and removes itself on dispose', () => {
    const { observation, source } = observe({ online: false });
    const state = window.__oiE2EEditorState!;
    expect(state.readOnly).toBe(false);
    expect(state.isOnline()).toBe(false);
    observation.notified('Saved', 'success');
    expect(state.notifications).toEqual([expect.objectContaining({ message: 'Saved', variant: 'success', online: false, hasLiveDoc: false })]);
    expect(source.isOnline()).toBe(false);
    expect(state.onlineReads).toEqual([expect.objectContaining({ online: false })]);
    observation.dispose();
    expect(window.__oiE2EEditorState).toBeUndefined();
  });

  it('records a stored photo, and a refused one with its code and every later read of that code', async () => {
    const stored = observe();
    await stored.store.put({ blob: new Blob(['abc'], { type: 'image/jpeg' }) });
    expect(window.__oiE2EEditorState!.storePuts).toEqual([{ contentType: 'image/jpeg', size: 3, online: true, outcome: 'stored' }]);
    stored.observation.dispose();

    const refusal = Object.assign(new Error('too big'), { code: 'TOO_LARGE' });
    const refused = observe({ put: () => Promise.reject(refusal) });
    await expect(refused.store.put({ blob: new Blob(['abcd'], { type: 'image/png' }) })).rejects.toBe(refusal);
    const state = window.__oiE2EEditorState!;
    expect(state.storePuts).toEqual([{ contentType: 'image/png', size: 4, online: true, outcome: 'rejected', code: 'TOO_LARGE' }]);
    state.codeReads.length = 0;
    expect((refusal as { code: string }).code).toBe('TOO_LARGE');
    expect(state.codeReads).toEqual([expect.objectContaining({ code: 'TOO_LARGE', name: 'Error', message: 'too big' })]);
  });

  it('keeps only the newest 40 link reads', () => {
    const { source } = observe();
    for (let index = 0; index < 45; index += 1) source.isOnline();
    expect(window.__oiE2EEditorState!.onlineReads).toHaveLength(40);
  });
});

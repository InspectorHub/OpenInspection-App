import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createUploadNotifier } from './notify.ts';

describe('upload completion notifications', () => {
  it('shows one fixed message only while unfocused and throttles drained batches for ten minutes', () => {
    let now = 0;
    let focused = false;
    const instances: Array<{ title: string; body: string; show: ReturnType<typeof vi.fn> }> = [];
    class FakeNotification {
      show = vi.fn();
      constructor(public options: { title: string; body: string }) { instances.push({ ...options, show: this.show }); }
    }
    const notify = createUploadNotifier({ Notification: FakeNotification, isFocused: () => focused, now: () => now });

    notify.onDrained({ failures: 0, completed: 3 });
    notify.onDrained({ failures: 4, completed: 3 });
    expect(instances).toEqual([{ title: 'InspectorHub', body: 'InspectorHub: uploads finished', show: expect.any(Function) }]);
    focused = true;
    now += 600_001;
    notify.onDrained({ failures: 1, completed: 3 });
    expect(instances).toHaveLength(1);
    focused = false;
    notify.onDrained({ failures: 1, completed: 3 });
    expect(instances[1]?.body).toBe('InspectorHub: some photos could not be uploaded');
    expect(instances[0]?.body).not.toMatch(/customer|tenant|photo name/i);
  });

  it('ignores a drain with no completed and no failed upload and does not spend the throttle slot on it', () => {
    const shown: string[] = [];
    class FakeNotification { constructor(public options: { title: string; body: string }) {} show(): void { shown.push(this.options.body); } }
    const notify = createUploadNotifier({ Notification: FakeNotification, isFocused: () => false, now: () => 0 });
    notify.onDrained({ failures: 0, completed: 0 });
    expect(shown).toEqual([]);
    notify.onDrained({ failures: 0, completed: 1 });
    expect(shown).toEqual(['InspectorHub: uploads finished']);
  });

  it('still notifies when every upload of the batch failed', () => {
    const shown: string[] = [];
    class FakeNotification { constructor(public options: { title: string; body: string }) {} show(): void { shown.push(this.options.body); } }
    const notify = createUploadNotifier({ Notification: FakeNotification, isFocused: () => false, now: () => 0 });
    notify.onDrained({ failures: 3, completed: 0 });
    expect(shown).toEqual(['InspectorHub: some photos could not be uploaded']);
  });

  it('sets the exact Windows app identity before constructing the upload notifier', () => {
    const main = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
    const identity = main.indexOf("app.setAppUserModelId('io.inspectorhub.app')");
    const notifier = main.indexOf('createUploadNotifier(');
    expect(identity).toBeGreaterThanOrEqual(0);
    expect(notifier).toBeGreaterThan(identity);
  });
});

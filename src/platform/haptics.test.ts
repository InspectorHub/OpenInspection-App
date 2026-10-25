import { afterEach, describe, expect, it, vi } from 'vitest';
import { NotificationType } from '@capacitor/haptics';
import { createCapacitorHaptics, haptic, setHapticsPort } from './haptics';

afterEach(() => setHapticsPort(null));

describe('createCapacitorHaptics', () => {
  it('maps success and warning to the plugin notification types', async () => {
    const notification = vi.fn(() => Promise.resolve());
    const port = createCapacitorHaptics({ notification });
    await port.notify('success');
    await port.notify('warning');
    expect(notification.mock.calls).toEqual([[{ type: NotificationType.Success }], [{ type: NotificationType.Warning }]]);
  });
});

describe('haptic', () => {
  it('hands the kind to the installed port', () => {
    const notify = vi.fn(() => Promise.resolve());
    setHapticsPort({ notify });
    haptic('success');
    expect(notify).toHaveBeenCalledWith('success');
  });

  it('never throws and never rejects: a missing plugin or a refusing device is not an error for the action', async () => {
    setHapticsPort({
      notify: () => {
        throw new Error('no plugin');
      },
    });
    expect(() => haptic('warning')).not.toThrow();
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    setHapticsPort({ notify: () => Promise.reject(new Error('refused')) });
    haptic('warning');
    await new Promise((resolve) => setTimeout(resolve, 20));
    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it('with the port removed, falls back to the real plugin without throwing (no plugin in a test run)', () => {
    setHapticsPort(null);
    expect(() => haptic('success')).not.toThrow();
  });
});

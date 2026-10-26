import { afterEach, describe, expect, it, vi } from 'vitest';
import { haptic, setHapticsPort } from './haptics';

afterEach(() => setHapticsPort(null));

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

  it('with no port set, does nothing and does not throw', () => {
    setHapticsPort(null);
    expect(() => haptic('success')).not.toThrow();
  });

  it('control: the same call reaches a port once one is set, and not after it is removed', () => {
    const notify = vi.fn(() => Promise.resolve());
    setHapticsPort({ notify });
    haptic('warning');
    setHapticsPort(null);
    haptic('warning');
    expect(notify).toHaveBeenCalledTimes(1);
  });
});

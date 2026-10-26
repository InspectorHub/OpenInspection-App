import { NotificationType } from '@capacitor/haptics';
import { describe, expect, it, vi } from 'vitest';
import { createCapacitorHaptics } from './haptics-capacitor';

describe('createCapacitorHaptics', () => {
  it('maps success and warning to the plugin notification types', async () => {
    const notification = vi.fn(() => Promise.resolve());
    const port = createCapacitorHaptics({ notification });
    await port.notify('success');
    await port.notify('warning');
    expect(notification.mock.calls).toEqual([[{ type: NotificationType.Success }], [{ type: NotificationType.Warning }]]);
  });
});

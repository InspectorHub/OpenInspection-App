import { describe, expect, it } from 'vitest';
import { connectionChip } from './connection';

const base = { auth: false, serverUnreachable: false, syncPaused: false };

describe('connectionChip', () => {
  it('is Online only when the link is up and the stack reports no server trouble', () => {
    expect(connectionChip(true, base)).toEqual({ label: 'Online', tone: 'ok' });
    expect(connectionChip(true, { ...base, serverUnreachable: true })?.label).toBe('Server unreachable');
    expect(connectionChip(true, { ...base, syncPaused: true })?.label).toBe('Sync paused');
  });
  it('lets the device link win, ignores a sign-in state, and hides while the link is unknown', () => {
    expect(connectionChip(false, { ...base, serverUnreachable: true })?.label).toBe('Offline');
    expect(connectionChip(false, { ...base, syncPaused: true })?.label).toBe('Offline');
    expect(connectionChip(true, { auth: true, serverUnreachable: true, syncPaused: false })?.label).toBe('Online');
    expect(connectionChip(null, { ...base, serverUnreachable: true })).toBeNull();
  });
});

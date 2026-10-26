// @vitest-environment jsdom
import { SystemBarsStyle } from '@capacitor/core';
import { describe, expect, it } from 'vitest';
import { followSystemColorScheme, type SchemeQuery } from './color-scheme';
import { createSystemBarsSync, type SystemBarsPort } from './system-bars';

function fakePort(): SystemBarsPort & { styles: SystemBarsStyle[] } {
  const styles: SystemBarsStyle[] = [];
  return {
    styles,
    setStyle: ({ style }) => {
      styles.push(style);
      return Promise.resolve();
    },
  };
}

function fakeQuery(matches: boolean): SchemeQuery & { flip(next: boolean): void } {
  const listeners = new Set<(event: { matches: boolean }) => void>();
  const query = {
    matches,
    addEventListener: (_type: 'change', listener: (event: { matches: boolean }) => void) => {
      listeners.add(listener);
    },
    removeEventListener: (_type: 'change', listener: (event: { matches: boolean }) => void) => {
      listeners.delete(listener);
    },
    flip: (next: boolean) => {
      query.matches = next;
      for (const listener of listeners) listener({ matches: next });
    },
  };
  return query;
}

describe('system bars follow the colour scheme', () => {
  it('uses light bar content on a dark app and dark content on a light one', () => {
    expect(SystemBarsStyle.Dark).toBe('DARK');
    expect(SystemBarsStyle.Light).toBe('LIGHT');
    const port = fakePort();
    const sync = createSystemBarsSync(port);
    sync(true);
    sync(false);
    expect(port.styles).toEqual([SystemBarsStyle.Dark, SystemBarsStyle.Light]);
  });

  it('is applied once at startup and again on every runtime change', () => {
    const port = fakePort();
    const query = fakeQuery(true);
    followSystemColorScheme(document.createElement('html'), query, createSystemBarsSync(port));
    expect(port.styles).toEqual([SystemBarsStyle.Dark]);
    query.flip(false);
    query.flip(true);
    expect(port.styles).toEqual([SystemBarsStyle.Dark, SystemBarsStyle.Light, SystemBarsStyle.Dark]);
  });

  it('a plugin that is missing or rejects (a browser during development) does not throw or leave a rejection', async () => {
    const rejecting: SystemBarsPort = { setStyle: () => Promise.reject(new Error('not implemented')) };
    const throwing: SystemBarsPort = {
      setStyle: () => {
        throw new Error('not implemented');
      },
    };
    expect(() => createSystemBarsSync(rejecting)(true)).not.toThrow();
    expect(() => createSystemBarsSync(throwing)(true)).not.toThrow();
    await Promise.resolve();
  });
});

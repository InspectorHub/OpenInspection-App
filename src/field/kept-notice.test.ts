import { describe, expect, it } from 'vitest';
import type { TimerPort } from '../collab/timers';
import { createManualTimers } from '../collab/test-support/manual-timers';
import { createKeptNotice, KEPT_WINDOW_MS } from './kept-notice';
import { photosKeptMessage } from './messages';

describe('createKeptNotice', () => {
  it('counts the photos kept inside one window into ONE sentence, item and defect photos apart', () => {
    const timers = createManualTimers();
    const said: string[] = [];
    const notice = createKeptNotice({ timers, say: (message) => said.push(message) });
    notice('insp-1', 'item');
    notice('insp-1', 'item');
    notice('insp-1', 'defect');
    expect(said).toEqual([]);
    expect(timers.requested()).toEqual([KEPT_WINDOW_MS, KEPT_WINDOW_MS]);
    timers.fireNext();
    timers.fireNext();
    expect(said).toEqual([photosKeptMessage('item', 2), photosKeptMessage('defect', 1)]);
  });

  it('opens a fresh window after the notice was shown', () => {
    const timers = createManualTimers();
    const said: string[] = [];
    const notice = createKeptNotice({ timers, say: (message) => said.push(message) });
    notice('insp-1', 'item');
    timers.fireNext();
    notice('insp-1', 'item');
    timers.fireNext();
    expect(said).toEqual([photosKeptMessage('item', 1), photosKeptMessage('item', 1)]);
  });

  describe('when the timer cannot be scheduled', () => {
    function flaky() {
      const real = createManualTimers();
      const state = { failing: true };
      const timers: TimerPort = {
        setTimeout: (callback, ms) => {
          if (state.failing) throw new Error('no timers');
          return real.setTimeout(callback, ms);
        },
        clearTimeout: (handle) => real.clearTimeout(handle),
      };
      return { real, state, timers };
    }

    it('the throw reaches the caller and the window is NOT left open: the next kept photo opens a window and is shown, with the count of the one that failed to schedule', () => {
      const { real, state, timers } = flaky();
      const said: string[] = [];
      const notice = createKeptNotice({ timers, say: (message) => said.push(message) });
      expect(() => notice('insp-1', 'item')).toThrow('no timers');
      state.failing = false;
      notice('insp-1', 'item');
      expect(real.pending()).toBe(1);
      real.fireNext();
      expect(said).toEqual([photosKeptMessage('item', 2)]);
    });

    it('control: with a working timer a second photo inside the window does not open a second window', () => {
      const { real, state, timers } = flaky();
      state.failing = false;
      const notice = createKeptNotice({ timers, say: () => undefined });
      notice('insp-1', 'item');
      notice('insp-1', 'item');
      expect(real.pending()).toBe(1);
    });

    it('the other kind is unaffected by a failure of this one', () => {
      const { real, state, timers } = flaky();
      const said: string[] = [];
      const notice = createKeptNotice({ timers, say: (message) => said.push(message) });
      expect(() => notice('insp-1', 'item')).toThrow('no timers');
      state.failing = false;
      notice('insp-1', 'defect');
      real.fireNext();
      expect(said).toEqual([photosKeptMessage('defect', 1)]);
    });
  });
});

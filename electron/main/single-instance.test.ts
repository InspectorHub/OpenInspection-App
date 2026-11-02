import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import { createSingleInstance } from './single-instance.ts';

it('stops a losing process with exit code zero and installs no listeners', () => {
  const app = Object.assign(new EventEmitter(), { requestSingleInstanceLock: () => false, quit: vi.fn() });
  const focus = vi.fn();
  expect(createSingleInstance({ app, onSecond: vi.fn(), focus })).toBe(false);
  expect(app.quit).toHaveBeenCalledExactlyOnceWith();
  expect(app.listenerCount('second-instance')).toBe(0);
  expect(focus).not.toHaveBeenCalled();
});

it('installs once and hands untrusted argv to the callback then focuses on every launch', () => {
  const app = Object.assign(new EventEmitter(), { requestSingleInstanceLock: vi.fn(() => true), quit: vi.fn() });
  const order: string[] = [];
  const onSecond = vi.fn(() => { order.push('second'); });
  const focus = () => { order.push('focus'); };
  expect(createSingleInstance({ app, onSecond, focus })).toBe(true);
  expect(createSingleInstance({ app, onSecond, focus })).toBe(true);
  app.emit('second-instance', {}, ['javascript:untrusted']);
  app.emit('second-instance', {}, ['--arg=secret']);
  expect(onSecond.mock.calls).toEqual([[['javascript:untrusted']], [['--arg=secret']]]);
  expect(order).toEqual(['second', 'focus', 'second', 'focus']);
  expect(app.requestSingleInstanceLock).toHaveBeenCalledOnce();
});

it('contains callback failures and still focuses without exposing exception contents', () => {
  const app = Object.assign(new EventEmitter(), { requestSingleInstanceLock: () => true, quit: vi.fn() });
  const focus = vi.fn();
  createSingleInstance({ app, onSecond: () => { throw new Error('SECRET'); }, focus });
  expect(() => app.emit('second-instance', {}, ['arg'])).not.toThrow();
  expect(focus).toHaveBeenCalledOnce();
});

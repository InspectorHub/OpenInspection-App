import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import { applyNavigationGuards, applyNavigationRequestPolicy, applyPermissionPolicy, type PermissionDetails, type SessionLike } from './security.ts';

it('blocks programmatic and redirected external documents while preserving remote subresources', () => {
  const onBeforeRequest = vi.fn();
  const session = { webRequest: { onBeforeRequest } };
  applyNavigationRequestPolicy(session);
  applyNavigationRequestPolicy(session);
  expect(onBeforeRequest).toHaveBeenCalledOnce();
  const handler = onBeforeRequest.mock.calls[0]![0];
  for (const [url, resourceType, cancel] of [
    ['https://localhost/', 'mainFrame', false],
    ['https://example.com/', 'mainFrame', true],
    ['https://localhost.evil/', 'mainFrame', true],
    ['https://localhost:8443/', 'mainFrame', true],
    ['https://example.com/', 'xhr', false],
    ['https://example.com/worker.js', 'script', false],
  ]) {
    const callback = vi.fn();
    handler({ url, resourceType }, callback);
    expect(callback).toHaveBeenCalledExactlyOnceWith(cancel ? { redirectURL: 'https://localhost' } : { cancel: false });
  }
});

it('blocks cross-origin navigation and every popup, opening only valid HTTPS links', async () => {
  const contents = Object.assign(new EventEmitter(), { setWindowOpenHandler: vi.fn() });
  const openExternal = vi.fn(async () => { throw new Error('secret'); });
  applyNavigationGuards({ webContents: contents }, { openExternal });
  applyNavigationGuards({ webContents: contents }, { openExternal });
  expect(contents.listenerCount('will-navigate')).toBe(1);
  const preventDefault = vi.fn();
  contents.emit('will-navigate', { preventDefault }, 'https://localhost/valid');
  expect(preventDefault).not.toHaveBeenCalled();
  contents.emit('will-navigate', { preventDefault }, 'https://example.com');
  await Promise.resolve();
  expect(preventDefault).toHaveBeenCalledOnce();
  expect(openExternal).toHaveBeenCalledExactlyOnceWith('https://example.com');
  const popup = contents.setWindowOpenHandler.mock.calls[0]![0];
  for (const url of ['file:///secret', 'javascript:alert(1)', 'ms-msdt:x', '\\\\server\\share', 'https:%2f%2fexample.com', 'https://user@example.com', 'http://example.com', '%68ttps://example.com', 'malformed']) {
    expect(popup({ url })).toEqual({ action: 'deny' });
  }
  expect(openExternal).toHaveBeenCalledTimes(1);
  expect(popup({ url: 'https://example.org/path' })).toEqual({ action: 'deny' });
  await Promise.resolve();
  expect(openExternal).toHaveBeenCalledTimes(2);
});

function permissions() {
  let request: Parameters<SessionLike['setPermissionRequestHandler']>[0] = () => {};
  let check: Parameters<SessionLike['setPermissionCheckHandler']>[0] = () => false;
  const session = { setPermissionRequestHandler: vi.fn((handler: typeof request) => { request = handler; }), setPermissionCheckHandler: vi.fn((handler: typeof check) => { check = handler; }) };
  applyPermissionPolicy(session);
  applyPermissionPolicy(session);
  expect(session.setPermissionRequestHandler).toHaveBeenCalledOnce();
  const webContents = { getURL: () => 'https://localhost/', isDestroyed: () => false };
  return {
    request(permission: string, details: PermissionDetails) { const callback = vi.fn(); request(webContents, permission, callback, details); return callback.mock.calls[0]?.[0]; },
    check(permission: string, origin: string, details: PermissionDetails) { return check(webContents, permission, origin, details); },
  };
}

it('grants only explicitly requested audio/video at the exact app origin', () => {
  const policy = permissions();
  const valid = { requestingUrl: 'https://localhost/', securityOrigin: 'https://localhost', isMainFrame: true, mediaTypes: ['audio', 'video'], mediaType: 'audio' };
  expect(policy.request('media', valid)).toBe(true);
  expect(policy.check('media', 'https://localhost', valid)).toBe(true);
  for (const permission of ['geolocation', 'clipboard-read', 'notifications', 'openExternal', 'unknown']) {
    expect(policy.request(permission, valid)).toBe(false);
    expect(policy.check(permission, 'https://localhost', valid)).toBe(false);
  }
  for (const origin of ['https://localhost.evil', 'https://localhost:8443', 'https://user@localhost', 'https://evil.example']) {
    expect(policy.request('media', { ...valid, securityOrigin: origin })).toBe(false);
    expect(policy.check('media', origin, valid)).toBe(false);
  }
  for (const details of [{ ...valid, requestingUrl: '' }, { ...valid, securityOrigin: undefined }, { ...valid, isMainFrame: false }, { ...valid, mediaTypes: [] }, { ...valid, mediaTypes: ['audio', 'unknown'] }]) expect(policy.request('media', details)).toBe(false);
  for (const details of [{ ...valid, mediaType: 'unknown' }, { ...valid, securityOrigin: undefined }, { ...valid, requestingUrl: 'https://evil.example' }, { ...valid, embeddingOrigin: 'https://evil.example' }]) expect(policy.check('media', 'https://localhost', details)).toBe(false);
});

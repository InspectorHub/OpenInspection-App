import { APP_ORIGIN, isAppOrigin } from './app-origin.ts';

export interface WindowLike {
  webContents: {
    on(event: 'will-navigate', listener: (event: { preventDefault(): void }, url: string) => void): unknown;
    setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' }): void;
  };
}

const guardedWindows = new WeakSet<object>();
const navigationSessions = new WeakSet<object>();

/** Electron's will-navigate omits programmatic loads; enforce the document boundary in the session too. */
export function applyNavigationRequestPolicy(session: {
  webRequest: { onBeforeRequest(handler: (details: { url: string; resourceType: string }, callback: (response: { cancel?: boolean; redirectURL?: string }) => void) => void): void };
}): void {
  if (navigationSessions.has(session)) return;
  navigationSessions.add(session);
  session.webRequest.onBeforeRequest((details, callback) => {
    // Redirect to the fixed entry instead of committing Chromium's error document after a CDP navigation abort.
    callback(details.resourceType === 'mainFrame' && !isAppOrigin(details.url) ? { redirectURL: APP_ORIGIN } : { cancel: false });
  });
}

/** External links must have an explicit HTTPS authority and no credentials or control bytes. */
function externalLink(value: string): boolean {
  if (!/^https:\/\//i.test(value) || /[\\\x00-\x20\x7f]/.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname !== '' && url.username === '' && url.password === '';
  } catch { return false; }
}

export function applyNavigationGuards(win: WindowLike, deps: { openExternal(url: string): Promise<void> }): void {
  if (guardedWindows.has(win.webContents)) return;
  guardedWindows.add(win.webContents);
  const open = (url: string): void => {
    if (externalLink(url) && !isAppOrigin(url)) void Promise.resolve().then(() => deps.openExternal(url)).catch(() => {});
  };
  win.webContents.on('will-navigate', (event, url) => {
    if (!isAppOrigin(url)) { event.preventDefault(); open(url); }
  });
  win.webContents.setWindowOpenHandler(({ url }) => { open(url); return { action: 'deny' }; });
}

export interface PermissionDetails {
  requestingUrl?: string;
  securityOrigin?: string;
  embeddingOrigin?: string;
  isMainFrame?: boolean;
  mediaTypes?: readonly string[];
  mediaType?: string;
}

interface PermissionContents { getURL(): string; isDestroyed(): boolean }
export interface SessionLike {
  setPermissionRequestHandler(handler: (contents: PermissionContents, permission: string, callback: (granted: boolean) => void, details: PermissionDetails) => void): void;
  setPermissionCheckHandler(handler: (contents: PermissionContents | null, permission: string, requestingOrigin: string, details: PermissionDetails) => boolean): void;
}

const guardedSessions = new WeakSet<object>();
const mediaTypeAllowed = (type: string): boolean => type === 'audio' || type === 'video';
function trustedMedia(contents: PermissionContents | null, permission: string, details: PermissionDetails): boolean {
  return permission === 'media' && contents !== null && !contents.isDestroyed() && isAppOrigin(contents.getURL())
    && details.isMainFrame === true && isAppOrigin(details.requestingUrl ?? '') && isAppOrigin(details.securityOrigin ?? '')
    && (details.embeddingOrigin === undefined || isAppOrigin(details.embeddingOrigin));
}

export function applyPermissionPolicy(session: SessionLike): void {
  if (guardedSessions.has(session)) return;
  guardedSessions.add(session);
  session.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(trustedMedia(contents, permission, details) && Array.isArray(details.mediaTypes) && details.mediaTypes.length > 0 && details.mediaTypes.every(mediaTypeAllowed));
  });
  session.setPermissionCheckHandler((contents, permission, origin, details) => {
    return isAppOrigin(origin) && trustedMedia(contents, permission, details) && mediaTypeAllowed(details.mediaType ?? '');
  });
}

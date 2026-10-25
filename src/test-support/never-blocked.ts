import type { IsBlocked } from '../offline/blocked';

/**
 * A guard that reports nothing as blocked. For tests whose subject is not the data-layer block: the modules take the
 * guard as a REQUIRED dependency, so a test that does not care about it says so explicitly with this.
 */
export const neverBlocked: IsBlocked = () => Promise.resolve(false);

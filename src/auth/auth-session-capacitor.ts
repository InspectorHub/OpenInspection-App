import { App } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import { type AuthSession, createAndroidAuthSession } from './auth-session';

/** Thin real-plugin wiring for Android; the behaviour is in `createAndroidAuthSession`, which the tests cover. */
export function createCapacitorAuthSession(): AuthSession {
  return createAndroidAuthSession({ browser: Browser, app: App });
}

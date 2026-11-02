import type { ClientPlatform } from '../app/compose';

/** The platform the shared editor package is told it runs on. The desktop client is a web page to it. */
export function fieldPlatformOf(platform: ClientPlatform): 'ios' | 'android' | 'web' {
  return platform === 'windows' ? 'web' : platform;
}

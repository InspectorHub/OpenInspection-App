import { describe, expect, it } from 'vitest';
import { AUTH_ERROR_CODES, AUTH_ERROR_MESSAGES, AUTH_ERROR_MESSAGE_KEYS, AuthError, isAuthError } from './errors';

describe('auth errors', () => {
  it('gives every code a fixed English message and a message key', () => {
    for (const code of AUTH_ERROR_CODES) {
      expect(AUTH_ERROR_MESSAGES[code].length).toBeGreaterThan(5);
      expect(AUTH_ERROR_MESSAGE_KEYS[code]).toMatch(/^auth\.error\.[A-Za-z]+$/);
    }
    expect(new Set(Object.values(AUTH_ERROR_MESSAGE_KEYS)).size).toBe(AUTH_ERROR_CODES.length);
  });

  it('carries only the fixed message, never anything the server said', () => {
    const err = new AuthError('callback_invalid');
    expect(err.message).toBe(AUTH_ERROR_MESSAGES.callback_invalid);
    expect(err.code).toBe('callback_invalid');
    expect(err.messageKey).toBe(AUTH_ERROR_MESSAGE_KEYS.callback_invalid);
    expect(isAuthError(err)).toBe(true);
    expect(isAuthError(new Error('x'))).toBe(false);
  });
});

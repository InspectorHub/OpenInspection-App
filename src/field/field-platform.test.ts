import { describe, expect, it } from 'vitest';
import { fieldPlatformOf } from './field-platform';

describe('fieldPlatformOf', () => {
  it.each([
    ['ios', 'ios'],
    ['android', 'android'],
    ['windows', 'web'],
  ] as const)('maps the client platform %s to the editor platform %s', (client, editor) => {
    expect(fieldPlatformOf(client)).toBe(editor);
  });
});

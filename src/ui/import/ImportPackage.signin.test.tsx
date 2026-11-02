// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { IMPORT_LIMIT_CEILINGS } from '@inspectorhub/offline-package';
import { cleanup, configure, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiOutcome } from '../../field/api-client';
import { makePackage } from '../../offline/test-support/import-fixtures';
import { ok, refused, runToResult } from '../test-support/import-test-kit';
import { bannedWordsIn } from './result-model';

configure({ asyncUtilTimeout: 5000 });
afterEach(cleanup);

const result = (): HTMLElement => screen.getByTestId('import-result');
const primary = (): HTMLElement => screen.getByTestId('import-primary-action');
const primaryButtons = (): HTMLElement[] => within(result()).getAllByRole('button').filter((b) => b.className.includes('bg-ih-primary text-ih-primary-fg'));
const problem = (p: Extract<ApiOutcome, { kind: 'problem' }>['problem']) => (): ApiOutcome => ({ kind: 'problem', problem: p });
const LIMITS = { inspections: 1, outbox: 500, photos: 1500, compressedBytes: IMPORT_LIMIT_CEILINGS.compressedBytes };

describe('the result after the sign-in ended the import', () => {
  it('"Sign in again" is the one main action; it calls the host once; the others are secondary', async () => {
    const signIn = vi.fn();
    await runToResult(makePackage({ inspections: 3 }), problem('auth'), signIn);
    expect(within(result()).getByRole('heading', { level: 2 })).toHaveTextContent('Nothing was imported.');
    expect(primary()).toHaveTextContent('Sign in again');
    expect(primaryButtons()).toEqual([primary()]);
    expect(screen.getByTestId('import-group-not_sent:auth')).toHaveTextContent(
      'Nothing was uploaded for them. Sign in again, then open Import package and choose the file again. Anything already imported is skipped.',
    );
    expect(within(result()).getByRole('button', { name: 'Import another file' })).toBeVisible();
    expect(within(result()).getByRole('button', { name: 'Done' })).toBeVisible();
    expect(within(result()).queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(signIn).not.toHaveBeenCalled();
    await userEvent.setup().click(primary());
    expect(signIn).toHaveBeenCalledTimes(1);
  });

  it('some inspections were imported before the sign-in ended: the safe and not-safe lines are on the page', async () => {
    const signIn = vi.fn();
    await runToResult(
      makePackage({ inspections: 3 }),
      (n, b) => (n === 1 ? refused(422, 'PACKAGE_TOO_LARGE', { limits: LIMITS }) : n === 2 ? ok(b) : { kind: 'problem', problem: 'auth' }),
      signIn,
    );
    expect(within(result()).getByRole('heading', { level: 2 })).toHaveTextContent('1 of 3 inspections was imported. 2 were not.');
    expect(within(result()).getByText('Safe: 1 inspection is on the server now.')).toBeVisible();
    // The first request carried all three, so the two it did not confirm may or may not be there.
    expect(within(result()).getByText('2 may or may not be on the server.')).toBeVisible();
    expect(primary()).toHaveTextContent('Sign in again');
    expect(primaryButtons()).toEqual([primary()]);
  });

  it('plain words, one primary action', async () => {
    await runToResult(makePackage({ inspections: 2 }), problem('auth'), vi.fn());
    expect(bannedWordsIn(result().textContent ?? '')).toEqual([]);
    expect(result().textContent).not.toContain('!');
    expect(primaryButtons()).toHaveLength(1);
  });
});

describe('the stops that signing in does not cure', () => {
  it.each([
    ['locked', 'Try again'],
    ['upgrade', 'Done'],
    ['server_too_old', 'Done'],
  ] as const)('%s: no "Sign in again" button, whatever the host can do', async (stop, label) => {
    const signIn = vi.fn();
    await runToResult(makePackage({ inspections: 2 }), problem(stop), signIn);
    expect(within(result()).queryByRole('button', { name: 'Sign in again' })).toBeNull();
    expect(primary()).toHaveTextContent(label);
    expect(primaryButtons()).toEqual([primary()]);
  });
});

describe('a host that cannot send the person to sign in', () => {
  it('gets the page exactly as it was: Try again, and the old sentence', async () => {
    await runToResult(makePackage({ inspections: 3 }), problem('auth'));
    expect(primary()).toHaveTextContent('Try again');
    expect(within(result()).queryByRole('button', { name: 'Sign in again' })).toBeNull();
    expect(screen.getByTestId('import-group-not_sent:auth')).toHaveTextContent('Nothing was uploaded for them. Sign in again, then choose Try again.');
    expect(primaryButtons()).toEqual([primary()]);
  });
});

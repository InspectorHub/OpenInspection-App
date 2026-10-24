import { useEffect, useState } from 'react';
import type { CompatNotice } from '../app/compat-notice';
import type { AppServices } from '../app/compose';
import { isAuthError } from '../auth/errors';
import type { SignInResult } from '../auth/pkce-login';
import { Body, Button, Heading, Notice, Screen } from './kit';
import { useActionLatch } from './latch';
import { messageFor, NOTICE_MESSAGES } from './messages';

export interface SignInProps {
  services: AppServices;
  origin: string;
  /** The server ended the session. Local data is untouched and the text says so. */
  relogin: boolean;
  notices: CompatNotice[];
  onSignedIn(result: SignInResult): void;
  onChangeServer(): void;
}

export function SignIn({ services, origin, relogin, notices, onSignedIn, onChangeServer }: SignInProps) {
  const { flow } = services;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [browserClosed, setBrowserClosed] = useState(false);
  const latch = useActionLatch();

  useEffect(() => {
    if (!busy) return undefined;
    return flow.onBrowserClosed(() => setBrowserClosed(true));
  }, [busy, flow]);

  async function signIn(): Promise<void> {
    setError(null);
    setBrowserClosed(false);
    setBusy(true);
    try {
      onSignedIn(await flow.signIn(origin));
    } catch (err) {
      // A cancel is the person's own choice: back to the button, with nothing to explain.
      if (!(isAuthError(err) && err.code === 'sign_in_cancelled')) setError(messageFor(err));
      setBusy(false);
    }
  }

  return (
    <Screen>
      <Heading>{relogin ? 'Sign in again' : 'Sign in'}</Heading>
      <Body>
        {relogin
          ? 'Your session on this server ended. The inspections and photos saved on this device are kept; signing in again picks up where you left off.'
          : 'You will sign in on a page from your server, then come back here.'}
      </Body>
      <p data-testid="server-origin" className="break-all font-ih-mono text-sm text-ih-fg-3">
        {origin}
      </p>
      {notices.map((notice) => (
        <Notice key={notice} tone="watch">
          {NOTICE_MESSAGES[notice]}
        </Notice>
      ))}
      {error && <Notice tone="bad">{error}</Notice>}
      {busy && browserClosed && <Notice tone="info">The sign-in page was closed. If you did not finish signing in, tap Cancel and try again.</Notice>}
      <div className="flex flex-col gap-3">
        {busy ? (
          <>
            <Button busy>
              Waiting for sign-in
            </Button>
            <Button variant="secondary" onClick={() => flow.cancel()}>
              Cancel
            </Button>
          </>
        ) : (
          <>
            <Button onClick={() => void latch(signIn)}>Sign in</Button>
            <Button variant="quiet" onClick={onChangeServer}>
              Use a different server
            </Button>
          </>
        )}
      </div>
    </Screen>
  );
}

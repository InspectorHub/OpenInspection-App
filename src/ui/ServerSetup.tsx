import { useId, useState, type FormEvent } from 'react';
import { compatNotices, type CompatNotice } from '../app/compat-notice';
import type { AppServices } from '../app/compose';
import { connectToServer } from '../app/connect';
import { isAuthError } from '../auth/errors';
import { parseServerUrl } from '../auth/server-config';
import { DevDiagnostics } from './dev-diagnostics';
import { Body, Button, Heading, INPUT_CLASSES, Notice, Screen } from './kit';
import { useActionLatch } from './latch';
import { messageFor, NATIVE_LOGIN_HELP } from './messages';

/** The hosted service's engine address (APP_BASE_URL of the engine's SaaS deployment). */
export const DEFAULT_SERVER_URL = 'https://app.inspectorhub.io';

export interface ServerSetupProps {
  services: AppServices;
  onConnected(origin: string, notices: CompatNotice[]): void;
  initialUrl?: string;
  /**
   * Lets a test turn the development-only switch off. The switch (plain http to a non-loopback host:
   * an emulator alias, a LAN address) is also gated on the build's own DEV flag, which
   * the bundler replaces with a constant, so a release build contains neither the control nor the option.
   */
  devHttpSwitch?: boolean;
}

type Step = { kind: 'edit' } | { kind: 'confirm'; origin: string; busy: boolean };

export function ServerSetup({ services, onConnected, initialUrl = DEFAULT_SERVER_URL, devHttpSwitch = true }: ServerSetupProps) {
  const showHttpSwitch = import.meta.env.DEV && devHttpSwitch;
  const inputId = useId();
  const errorId = useId();
  const [url, setUrl] = useState(initialUrl);
  const [allowHttp, setAllowHttp] = useState(false);
  const [step, setStep] = useState<Step>({ kind: 'edit' });
  const [error, setError] = useState<string | null>(null);
  const [nativeUnavailable, setNativeUnavailable] = useState(false);
  const latch = useActionLatch();

  function review(event: FormEvent): void {
    event.preventDefault();
    try {
      const origin = parseServerUrl(url, { allowInsecureHttp: showHttpSwitch && allowHttp });
      setError(null);
      setStep({ kind: 'confirm', origin, busy: false });
    } catch (err) {
      setError(messageFor(err, 'invalid_server_url'));
    }
  }

  async function connect(origin: string): Promise<void> {
    setError(null);
    setNativeUnavailable(false);
    setStep({ kind: 'confirm', origin, busy: true });
    try {
      const compat = await connectToServer(services, origin);
      onConnected(origin, compatNotices(compat, services.appVersion));
    } catch (err) {
      setError(messageFor(err, 'server_unreachable'));
      setNativeUnavailable(isAuthError(err) && err.code === 'native_login_unavailable');
      setStep({ kind: 'confirm', origin, busy: false });
    }
  }

  if (step.kind === 'confirm') {
    const { origin, busy } = step;
    return (
      <Screen>
        <Heading>Connect to this server?</Heading>
        <div className="rounded-ih-card border border-ih-border-strong bg-ih-bg-muted px-4 py-3">
          <p data-testid="canonical-origin" className="break-all font-ih-mono text-lg text-ih-fg-1">
            {origin}
          </p>
        </div>
        <Body>Check that this is the address your company gave you. You will sign in on this server.</Body>
        {error && <Notice tone="bad">{error}</Notice>}
        {nativeUnavailable && <Notice tone="info">{NATIVE_LOGIN_HELP}</Notice>}
        <div className="flex flex-col gap-3">
          <Button busy={busy} onClick={() => void latch(() => connect(origin))}>
            {busy ? 'Connecting' : 'Connect'}
          </Button>
          <Button variant="secondary" disabled={busy} onClick={() => setStep({ kind: 'edit' })}>
            Change address
          </Button>
        </div>
      </Screen>
    );
  }

  return (
    <Screen>
      <Heading>Choose your server</Heading>
      <form className="flex flex-col gap-4" onSubmit={review} noValidate>
        <div className="flex flex-col gap-2">
          <label htmlFor={inputId} className="text-base font-semibold text-ih-fg-1">
            Server address
          </label>
          <input
            id={inputId}
            type="url"
            inputMode="url"
            autoCapitalize="none"
            autoCorrect="off"
            autoComplete="url"
            spellCheck={false}
            placeholder="https://app.example.com"
            className={INPUT_CLASSES}
            value={url}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            onChange={(event) => {
              setUrl(event.target.value);
              setError(null);
            }}
          />
        </div>
        {showHttpSwitch && (
          <label className="flex min-h-11 items-center gap-3 text-base text-ih-fg-2">
            <input type="checkbox" className="size-5 accent-ih-primary" checked={allowHttp} onChange={(event) => setAllowHttp(event.target.checked)} />
            Allow plain http (development only)
          </label>
        )}
        {error && (
          <div id={errorId}>
            <Notice tone="bad">{error}</Notice>
          </div>
        )}
        <Button type="submit">Continue</Button>
      </form>
      <DevDiagnostics services={services} origin={null} />
    </Screen>
  );
}

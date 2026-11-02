import { useMemo } from 'react';
import { editorPorts } from '../../app/editor-ports';
import { createApiClient } from '../../field/api-client';
import type { ImportScreenProps } from '../import-loader';
import { ImportPackage } from './ImportPackage';

/**
 * The import screen of a signed-in session: the same authenticated client the editor's writes use (pinned origin, Bearer token, the
 * lock and the server-too-old gates asked right before every request), handed to the screen.
 */
export function ImportScreen({ services, origin, stack, timers, onClose, onSignInAgain }: ImportScreenProps) {
  const api = useMemo(() => {
    const ports = editorPorts(services, stack, origin);
    return createApiClient({
      http: services.http,
      tokens: services.tokens,
      origin,
      clientHeaders: { 'X-Client-Platform': services.platform, 'X-Client-Version': services.appVersion },
      gate: ports.api.gate,
      serverTooOld: ports.api.serverTooOld,
    });
  }, [services, stack, origin]);
  return (
    <ImportPackage
      api={api}
      tenantId={stack.account.tenantId}
      share={{ files: services.files, sharer: services.sharer, platform: services.platform, ...(timers === undefined ? {} : { timers }) }}
      now={() => services.clock.now()}
      onClose={onClose}
      {...(onSignInAgain === undefined ? {} : { onSignInAgain })}
    />
  );
}

import { useId } from 'react';
import type { AppServices } from '../../app/compose';
import { parseBuiltAt } from '../../platform/build-info';
import { Body } from '../kit';
import { dateLabel } from '../worklist/format';
import { ExternalLink } from './ExternalLink';

/** Where the source of this app is published. Offering it satisfies section 13 of the GNU Affero General Public License. */
export const SOURCE_URL = 'https://github.com/InspectorHub/OpenInspection-App';
export const LICENSE_URL = 'https://www.gnu.org/licenses/agpl-3.0.html';
export const LICENSE_NAME = 'GNU Affero General Public License v3.0 (AGPL-3.0)';

export interface AboutSectionProps {
  services: Pick<AppServices, 'appVersion' | 'builtAt' | 'openExternal'>;
  locale: string | undefined;
}

/** The licence, where to get the source code, and which build this is. */
export function AboutSection({ services, locale }: AboutSectionProps) {
  const headingId = useId();
  const builtAt = parseBuiltAt(services.builtAt);
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h2 id={headingId} className="font-ih-display text-lg font-bold tracking-tight text-ih-fg-1">
        Open source
      </h2>
      <Body>{`InspectorHub is free software, released under the ${LICENSE_NAME}. The source code of this app, including the changes in this version, is available to everyone who uses it.`}</Body>
      <ExternalLink services={services} url={SOURCE_URL} label="Source code" accessibleName="Source code, opens in your browser" />
      <ExternalLink services={services} url={LICENSE_URL} label="Read the licence" accessibleName="Read the licence, opens in your browser" />
      <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-4 gap-y-2 text-base">
        <dt className="text-ih-fg-3">App version</dt>
        <dd data-testid="app-version" className="text-ih-fg-1">
          {services.appVersion}
        </dd>
        <dt className="text-ih-fg-3">Built</dt>
        <dd data-testid="built-on" className="text-ih-fg-1">
          {builtAt === null ? 'Unknown' : dateLabel(builtAt, locale)}
        </dd>
      </dl>
    </section>
  );
}

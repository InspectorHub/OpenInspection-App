import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { WorkListHeader } from '../../src/ui/worklist/WorkListHeader';
import '../../src/styles.css';

// The work-list header in one state, for the screenshot set: `?state=idle|downloading|summary`.
const state = new URLSearchParams(location.search).get('state') ?? 'idle';
document.documentElement.dataset.colorScheme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
const noop = () => undefined;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <main className="mx-auto max-w-md p-4">
      <WorkListHeader
        updatedAt={Date.now() - 120_000}
        now={Date.now()}
        locale="en-US"
        chip={null}
        downloading={state === 'downloading'}
        summary={state === 'summary' ? 'Updated 3 inspections.' : null}
        onDownload={noop}
        headingRef={noop}
        onSettings={noop}
        settingsRef={noop}
      />
      <p className="mt-4 text-base">First inspection row (stays put while downloading)</p>
    </main>
  </StrictMode>,
);

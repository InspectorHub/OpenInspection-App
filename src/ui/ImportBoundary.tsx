import { Component, type ReactNode } from 'react';
import { BackLink, Body, Heading, Notice, Screen } from './kit';
import { useBackHandler } from './use-back-handler';

export const IMPORT_UNAVAILABLE = 'The import could not be opened. Nothing was sent, and your work on this device is safe.';
export const IMPORT_OPENING = 'Opening the import…';

interface Props {
  onBack(): void;
  children: ReactNode;
}

/** Catches a failed load of the import screen's chunk (or a crash in it) so the rest of the app stays up. */
export class ImportBoundary extends Component<Props, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <Screen>
        <BackLink label="Settings" ariaLabel="Back to settings" onClick={this.props.onBack} />
        <Heading>Import a package</Heading>
        <Notice tone="bad">{IMPORT_UNAVAILABLE}</Notice>
      </Screen>
    );
  }
}

/**
 * Shown while the import screen's chunk loads. The screen it replaces is already gone, so the back key is used up here: a press that
 * fell through would leave the app while the person is part-way into an import.
 */
export function ImportLoading() {
  useBackHandler(() => true);
  return (
    <Screen>
      <div role="status" aria-busy="true">
        <Body>{IMPORT_OPENING}</Body>
      </div>
    </Screen>
  );
}

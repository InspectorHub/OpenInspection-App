import { Component, type ReactNode } from 'react';
import { Button, Heading, Notice, Screen } from './kit';

export const EDITOR_UNAVAILABLE = 'The editor could not be opened. Your work on this device is safe.';

interface Props {
  onBack(): void;
  children: ReactNode;
}

/** Catches a failed load of the editor's chunk (or a crash in it) so the rest of the app stays up. */
export class EditorBoundary extends Component<Props, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <Screen>
        <Heading>Inspection</Heading>
        <Notice tone="bad">{EDITOR_UNAVAILABLE}</Notice>
        <Button variant="secondary" onClick={this.props.onBack}>
          Back to work list
        </Button>
      </Screen>
    );
  }
}

import { Component, type ReactNode } from 'react';
import { ROW_UNAVAILABLE } from './copy';

interface Props {
  children: ReactNode;
}

/**
 * Keeps one row that fails to render from blanking the whole list: the row is replaced by a fixed line. The error itself
 * is dropped on purpose (its text could carry an address or an id), so nothing about it is logged or shown.
 */
export class RowBoundary extends Component<Props, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(): void {
    // Deliberately empty: see the class comment.
  }

  override render(): ReactNode {
    if (this.state.failed) return <li className="rounded-ih-card border border-ih-border bg-ih-bg-card p-3 text-sm text-ih-fg-2">{ROW_UNAVAILABLE}</li>;
    return this.props.children;
  }
}

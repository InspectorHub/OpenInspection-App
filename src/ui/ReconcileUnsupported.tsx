import { Button, Notice } from './kit';

/** A low-priority line: the server has no check for removed inspections, so deleted ones stay on this device until it is updated. */
export function ReconcileUnsupported({ onDismiss }: { onDismiss(): void }) {
  return (
    <Notice tone="info">
      <p>This server does not support removing deleted inspections.</p>
      <Button variant="quiet" className="mt-2" aria-label="Dismiss server notice" onClick={onDismiss}>
        Dismiss
      </Button>
    </Notice>
  );
}

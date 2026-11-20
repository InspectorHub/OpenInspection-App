/**
 * Electron-only Settings entry for the guided move flow. The web app never
 * renders it. It only offers the two directions; the wizard owns the steps.
 */
import { Button } from '../kit';

export interface MoveDataPackageSectionProps {
  onLeave(): void;
  onArrive(): void;
}

export function MoveDataPackageSection({ onLeave, onArrive }: MoveDataPackageSectionProps) {
  return (
    <section aria-labelledby="move-heading" className="flex flex-col gap-3">
      <h2 id="move-heading" className="font-ih-display text-lg font-bold text-ih-fg-1">Move to another deployment</h2>
      <p className="text-sm text-ih-fg-2">
        Copy this company to a data package, or restore one that came from elsewhere. The steps run on this computer.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button onClick={onLeave}>Leave this workspace</Button>
        <Button variant="secondary" onClick={onArrive}>Arrive at this workspace</Button>
      </div>
    </section>
  );
}

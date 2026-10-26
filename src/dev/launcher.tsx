import { lazy, Suspense, useState } from 'react';
import type { AppServices } from '../app/compose';
import { Button } from '../ui/kit';

const Diagnostics = lazy(() => import('./diagnostics').then((module) => ({ default: module.Diagnostics })));

export interface DiagnosticsLauncherProps {
  services: AppServices;
  origin: string | null;
}

/** The button that opens the diagnostics screen. Only ever loaded by a development build. */
export default function DiagnosticsLauncher({ services, origin }: DiagnosticsLauncherProps) {
  const [open, setOpen] = useState(false);
  if (open) {
    return (
      <Suspense fallback={null}>
        <Diagnostics services={services} origin={origin} onClose={() => setOpen(false)} />
      </Suspense>
    );
  }
  return (
    <Button variant="quiet" onClick={() => setOpen(true)}>
      Diagnostics (development only)
    </Button>
  );
}

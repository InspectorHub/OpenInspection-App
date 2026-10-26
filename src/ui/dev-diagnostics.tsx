import { lazy, Suspense } from 'react';
import type { AppServices } from '../app/compose';

// Marked pure so a release build, where the only use below is dead code, drops this call and its dynamic import.
const Launcher = /* @__PURE__ */ lazy(() => import('../dev/launcher'));

/**
 * The development-only door to the diagnostics screen. The build's own DEV flag is replaced by a constant, so a
 * release bundle holds neither this branch nor the screen behind it (`npm run check:bundle` verifies that).
 */
export function DevDiagnostics({ services, origin }: { services: AppServices; origin: string | null }) {
  if (!import.meta.env.DEV) return null;
  return (
    <Suspense fallback={null}>
      <Launcher services={services} origin={origin} />
    </Suspense>
  );
}

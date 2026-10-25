import type { ReactNode } from 'react';

export type BadgeTone = 'ok' | 'watch' | 'bad' | 'info' | 'neutral';

const TONES: Record<BadgeTone, string> = {
  ok: 'bg-ih-ok-bg text-ih-ok-fg',
  watch: 'bg-ih-watch-bg text-ih-watch-fg',
  bad: 'bg-ih-bad-bg text-ih-bad-fg',
  info: 'bg-ih-info-bg text-ih-info-fg',
  neutral: 'bg-ih-bg-muted text-ih-fg-2',
};

/** A short state label. The words carry the meaning; the tone only helps the eye, so it is never the only signal. */
export function Badge({ tone, children }: { tone: BadgeTone; children: ReactNode }) {
  return <span className={`inline-flex max-w-full items-center break-words [overflow-wrap:anywhere] rounded-ih-pill px-2 py-1 text-left text-xs font-bold leading-snug ${TONES[tone]}`}>{children}</span>;
}

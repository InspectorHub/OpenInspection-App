import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';

/**
 * The page frame: full height, safe-area padding, a plain column on a phone and a single
 * card centred on a tablet. Colours come only from the field-ui theme tokens.
 */
export function Screen({ children }: { children: ReactNode }) {
  return (
    <div className="safe-pad flex min-h-dvh flex-col items-center justify-start md:justify-center">
      <main className="flex w-full max-w-md flex-col gap-6 md:rounded-ih-modal md:border md:border-ih-border md:bg-ih-bg-card md:p-8 md:shadow-ih-popover">
        <p className="font-ih-display text-lg font-bold tracking-tight text-ih-primary-text">InspectorHub</p>
        {children}
      </main>
    </div>
  );
}

export function Heading({ children }: { children: ReactNode }) {
  return <h1 className="font-ih-display text-2xl font-bold tracking-tight text-ih-fg-1">{children}</h1>;
}

export function Body({ children }: { children: ReactNode }) {
  return <p className="text-base leading-relaxed text-ih-fg-2">{children}</p>;
}

type Tone = 'info' | 'watch' | 'bad';

const TONE_CLASSES: Record<Tone, string> = {
  info: 'bg-ih-info-bg text-ih-info-fg',
  watch: 'bg-ih-watch-bg text-ih-watch-fg',
  bad: 'bg-ih-bad-bg text-ih-bad-fg',
};

/** A message with a role: errors announce themselves (`alert`), everything else is a polite status. */
export function Notice({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <div role={tone === 'bad' ? 'alert' : 'status'} className={`rounded-ih-card px-3 py-2 text-sm leading-relaxed ${TONE_CLASSES[tone]}`}>
      {children}
    </div>
  );
}

type Variant = 'primary' | 'secondary' | 'quiet';

const BUTTON_BASE = 'min-h-11 w-full rounded-ih-button px-4 text-base font-semibold focus-visible:outline-none focus-visible:shadow-ih-focus';

/** A disabled control is dimmed; that drops the primary button's text to about 3:1 in the dark scheme. */
const DISABLED = 'disabled:cursor-not-allowed disabled:opacity-60';
/** A busy control is working, not unavailable: it keeps full contrast and shows the progress cursor. */
const BUSY = 'cursor-progress';

const VARIANT_CLASSES: Record<Variant, string> = {
  primary: 'bg-ih-primary text-ih-primary-fg',
  secondary: 'border border-ih-border-strong bg-ih-bg-card text-ih-fg-1 hover:bg-ih-bg-muted',
  quiet: 'text-ih-primary-text hover:bg-ih-bg-muted',
};

export function Button({
  variant = 'primary',
  busy = false,
  disabled,
  className = '',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; busy?: boolean; ref?: Ref<HTMLButtonElement> }) {
  return (
    <button
      type="button"
      className={`${BUTTON_BASE} ${VARIANT_CLASSES[variant]} ${busy ? BUSY : DISABLED} ${className}`}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      {...rest}
    />
  );
}

export const INPUT_CLASSES =
  'min-h-11 w-full rounded-ih-input border border-ih-border-strong bg-ih-bg-card px-3 text-base text-ih-fg-1 placeholder:text-ih-fg-3 focus:border-ih-primary focus:outline-none focus:shadow-ih-focus';

import { useEffect, useId, useState } from 'react';
import type { InspectionPrefs } from '@inspectorhub/field-ui';
import type { PrefsStore, PrefsView } from '../../field/prefs-store';
import { Notice } from '../kit';
import { useActionLatch } from '../latch';
import { LiveNote } from '../worklist/LiveNote';

export const AUTO_ADVANCE_LEGEND = 'Auto-advance after rating';
export const AUTO_ADVANCE_KEYBOARD = 'Keyboard rating only (1-5 speed-scans; taps stay on the item)';
export const AUTO_ADVANCE_ALWAYS = 'Always (taps and keyboard both advance)';
export const AUTO_ADVANCE_OFF = 'Never (always stay on the item)';
export const AUTO_ADVANCE_NOTE = 'Defect and Monitor-style ratings always stay on the item and focus Notes so you can describe the finding.';
export const COMPANY_WIDE = 'This applies to everyone in your company, not only to this device.';
export const PREFS_PENDING_NOTE = 'Saved on this device. It will update your company when you are back online.';
export const PREFS_SAVE_FAILED = 'The setting was not saved. Try again.';

type AutoAdvance = InspectionPrefs['autoAdvance'];

const CHOICES: readonly { value: AutoAdvance; label: string }[] = [
  { value: 'keyboard', label: AUTO_ADVANCE_KEYBOARD },
  { value: 'always', label: AUTO_ADVANCE_ALWAYS },
  { value: 'off', label: AUTO_ADVANCE_OFF },
];

export interface InspectionSectionProps {
  prefs: Pick<PrefsStore, 'read' | 'peek' | 'patch' | 'subscribe'>;
}

/**
 * The company's auto-advance setting, the same three choices as the web app's Settings > Inspection. It shows the value this device
 * last read (so it is right offline and after a restart), and a change made without a connection applies at once and is sent when
 * the connection returns; until then a note says so. The role is not checked here: every role that can sign in to this app may
 * change this one field, and the server's refusal, if there ever is one, is shown and the control goes back.
 */
export function InspectionSection({ prefs }: InspectionSectionProps) {
  const headingId = useId();
  const name = useId();
  const [value, setValue] = useState<AutoAdvance | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const latch = useActionLatch();

  useEffect(() => {
    let live = true;
    const show = (look: () => Promise<PrefsView>): void => {
      look().then(
        (view) => {
          if (!live) return;
          setValue(view.prefs.autoAdvance);
          setWaiting(view.pending);
        },
        () => undefined,
      );
    };
    // The stored value first, so the control is usable at once on a weak connection; the read refines it when it answers.
    show(() => prefs.peek());
    show(() => prefs.read());
    // A change made here or a send that finished: look at what is stored, do not ask the server again.
    const stop = prefs.subscribe(() => show(() => prefs.peek()));
    return () => {
      live = false;
      stop();
    };
  }, [prefs]);

  async function choose(choice: AutoAdvance): Promise<void> {
    if (choice === value) return;
    await latch(async () => {
      const before = value;
      setFailed(null);
      setValue(choice);
      try {
        const result = await prefs.patch({ autoAdvance: choice });
        if (!result.ok) {
          setValue(before);
          setFailed(result.error || PREFS_SAVE_FAILED);
        }
      } catch {
        setValue(before);
        setFailed(PREFS_SAVE_FAILED);
      }
    });
  }

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h2 id={headingId} className="font-ih-display text-lg font-bold tracking-tight text-ih-fg-1">
        Inspection
      </h2>
      <fieldset className="flex flex-col gap-1">
        <legend className="text-base text-ih-fg-2">{AUTO_ADVANCE_LEGEND}</legend>
        {CHOICES.map((choice) => (
          <label key={choice.value} className="flex min-h-11 items-center gap-3 text-base text-ih-fg-1">
            <input type="radio" name={name} className="size-5 shrink-0 accent-ih-primary" value={choice.value} checked={value === choice.value} disabled={value === null} onChange={() => void choose(choice.value)} />
            {choice.label}
          </label>
        ))}
      </fieldset>
      <p className="text-sm leading-relaxed text-ih-fg-3">{AUTO_ADVANCE_NOTE}</p>
      <p className="text-sm leading-relaxed text-ih-fg-3">{COMPANY_WIDE}</p>
      {failed !== null && <Notice tone="bad">{failed}</Notice>}
      <LiveNote testId="prefs-note" className="text-sm leading-relaxed text-ih-fg-2" text={waiting ? PREFS_PENDING_NOTE : ''} />
    </section>
  );
}

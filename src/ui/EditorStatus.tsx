import { useSyncExternalStore } from 'react';
import type { StackStatus } from '../app/offline-stack';
import type { ReadableStore } from '../app/stack-store';
import type { TimerPort } from '../collab/timers';
import type { Db } from '../platform/db';
import type { Network } from '../platform/network';
import { useWaitingCount } from './use-waiting-count';
import { COLLAB_ISSUE_CHIP_TEXT, EDITS_NOT_SAVED_TEXT, SERVER_UNREACHABLE_CHIP_TEXT, SYNC_PAUSED_TEXT, UPDATE_REQUIRED_TITLE } from './worklist/copy';
import { useOnline } from './worklist/useOnline';

type Tone = 'bad' | 'watch' | 'muted';

const TONES: Record<Tone, string> = {
  bad: 'bg-ih-bad-bg text-ih-bad-fg',
  watch: 'bg-ih-watch-bg text-ih-watch-fg',
  muted: 'bg-ih-bg-muted text-ih-fg-2',
};

/**
 * The fixed line for the state, or null when all is well. Most serious first: edits not stored, an app version the server refuses,
 * sync paused, a sign-in the session needs, no connection, a server that does not answer, trouble with live collaboration, the queue.
 * No connection comes before the last two on purpose: with no link, "can't reach the server" and a failed live socket are
 * expected and add nothing, and the work list likewise hides the unreachable line while offline. The chip's short wording lives
 * next to the work list's longer lines in `worklist/copy`.
 */
export function editorStatusLine(online: boolean | null, waiting: number | null, status: Pick<StackStatus, 'auth' | 'editsNotSaved' | 'upgrade' | 'syncPaused' | 'serverUnreachable' | 'collabIssue'>): { text: string; tone: Tone } | null {
  const queued = waiting ?? 0;
  if (status.editsNotSaved) return { text: EDITS_NOT_SAVED_TEXT, tone: 'bad' };
  if (status.upgrade) return { text: UPDATE_REQUIRED_TITLE, tone: 'bad' };
  if (status.syncPaused) return { text: SYNC_PAUSED_TEXT, tone: 'watch' };
  if (status.auth) return { text: 'Sign in again', tone: 'watch' };
  if (online === false) return { text: queued > 0 ? `Offline · ${String(queued)} waiting on this device` : 'Offline', tone: 'muted' };
  if (status.serverUnreachable) return { text: SERVER_UNREACHABLE_CHIP_TEXT, tone: 'watch' };
  if (status.collabIssue) return { text: COLLAB_ISSUE_CHIP_TEXT, tone: 'watch' };
  if (queued > 0) return { text: `${String(queued)} waiting on this device`, tone: 'watch' };
  return null;
}

export interface EditorStatusProps {
  db: Db;
  status: ReadableStore<StackStatus>;
  /** Link state source. Without one the page's own online and offline events are used. */
  network?: Pick<Network, 'online' | 'onChange'> | undefined;
  timers?: TimerPort | undefined;
}

/**
 * A small, information-only chip for the editor header: offline, things waiting on this device, or a problem that needs the person. It
 * renders nothing when all is well. It is not a control (there is nothing to press here). The count is the whole device's
 * queue, read at the same pace as the work list's.
 */
export function EditorStatus({ db, status, network, timers }: EditorStatusProps) {
  const stackStatus = useSyncExternalStore(status.subscribe, status.get);
  const online = useOnline(network);
  const waiting = useWaitingCount(db, timers === undefined ? {} : { timers });
  const line = editorStatusLine(online, waiting, stackStatus);
  if (line === null) return null;
  return (
    <span role="status" className={`inline-flex max-w-[16rem] shrink-0 items-center rounded-ih-pill px-2 py-0.5 text-xs font-bold ${TONES[line.tone]}`}>
      {line.text}
    </span>
  );
}

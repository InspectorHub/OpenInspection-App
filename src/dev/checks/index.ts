import { collabTicket } from './collab-ticket';
import { dbBlob } from './db-blob';
import { dbTx } from './db-tx';
import { filesCheck } from './files';
import { lockClock, lockSimulate } from './lock-clock';
import { permissions } from './permissions';
import { killClean, killResume, killStart } from './uploader-kill';
import { uploaderPhoto } from './uploader-photo';
import { yjsPersist } from './yjs-persist';
import type { CheckDef, ExtraDef } from './types';

/** The checks "Run all" runs, in order. */
export const CHECKS: readonly CheckDef[] = [dbBlob, dbTx, yjsPersist, filesCheck, lockClock, uploaderPhoto, permissions, collabTicket];

/** Buttons that belong to a check but are never part of "Run all": each needs the operator. */
export const EXTRAS: readonly ExtraDef[] = [lockSimulate, killStart, killResume, killClean];

export { stopKillSession } from './uploader-kill';

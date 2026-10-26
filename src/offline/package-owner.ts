import type { Db } from '../platform/db';
import { sameAccount, type Account } from './outbox';

/** Answers whether the package of an inspection provably belongs to another account than the one asking. */
export type IsOtherAccount = (inspectionId: string) => Promise<boolean>;

interface OwnerRow {
  tenant_id: string | null;
  user_id: string | null;
}

/**
 * The device can hold the packages of more than one account (a package of an account that signed out stays until it is
 * removed). This answers true only when the package row names an owner and the owner is not `who`; a package with no
 * owner recorded (written before owners were recorded), and an inspection with no package row, are not another account's.
 * When the account cannot be read the answer is true: a stack that is not sure whose it is touches nothing.
 * Rejects when the read fails; the caller decides what a failed read means.
 */
export function createOtherAccountGuard(db: Pick<Db, 'query'>, who: () => Promise<Account | null>): IsOtherAccount {
  return async (inspectionId) => {
    const account = await who();
    if (account === null) return true;
    const rows = await db.query<OwnerRow>('SELECT tenant_id, user_id FROM work_package WHERE inspection_id = ?', [inspectionId]);
    const owner = rows[0];
    if (owner === undefined || (owner.tenant_id === null && owner.user_id === null)) return false;
    return !sameAccount(account, owner.tenant_id, owner.user_id);
  };
}

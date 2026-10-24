/**
 * True for the lowest-seq row of each line of one account; `o` is the outer row. `IS` is the NULL-safe equality, so
 * the line of inspection-free writes is one line, and it lets the lookup use `idx_outbox_line` (a COALESCE could not).
 */
const IS_HEAD = `seq = (SELECT MIN(i.seq) FROM outbox i WHERE i.tenant_id = o.tenant_id AND i.user_id = o.user_id AND i.inspection_id IS o.inspection_id)`;

/** Parameters: tenant, user, now, farAhead. The earliest instant at which a waiting head becomes due. */
export const WAITING_SQL = `SELECT MIN(next_at) AS at FROM outbox o WHERE tenant_id = ? AND user_id = ? AND state = 'pending' AND next_at > ? AND next_at <= ? AND ${IS_HEAD}`;

/** Parameters: tenant, user, now, farAhead, page size. The heads that may be sent now, lowest seq first. */
export const HEADS_SQL = `SELECT idempotency_key FROM outbox o
         WHERE tenant_id = ? AND user_id = ? AND state = 'pending' AND (next_at IS NULL OR next_at <= ? OR next_at > ?) AND ${IS_HEAD}
         ORDER BY seq LIMIT ?`;

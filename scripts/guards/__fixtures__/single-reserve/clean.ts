// Fixture: legitimate code that mentions the tracked column names in
// unrelated contexts (a TS field name, a read-only SELECT) and issues an
// unrelated UPDATE on pacing_ledger that never writes any of the four
// tracked columns - must stay clean.
export interface PacingLedgerRow {
  consumed_count: number;
  sent_this_hour: number;
}

export function readConsumedCount(row: PacingLedgerRow): number {
  return row.consumed_count;
}

export function touchUpdatedAt(): string {
  return 'UPDATE pacing_ledger SET updated_at = now() WHERE instance_id = $1';
}

// A parameterized UPDATE on pacing_ledger that never touches any tracked
// column - proves COLUMN_WRITE_PATTERN doesn't false-positive on an
// unrelated column.
export function touchLastReservedAt(): string {
  return 'UPDATE pacing_ledger SET last_reserved_at = $1 WHERE instance_id = $2';
}

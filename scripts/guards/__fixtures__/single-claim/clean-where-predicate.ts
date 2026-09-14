// Fixture (P09 debugger fix): the same conditional-transition shape as
// clean-where-predicate.sql, but as a TS template literal - a SET clause
// that writes a DIFFERENT status, with 'processing' only ever appearing in
// the WHERE predicate. Must stay clean; must not be confused with a second
// claim UPDATE just because 'processing' co-occurs with message_jobs, SET,
// and status somewhere in the same statement.
export function markNeedsReconcileSql(): string {
  return `UPDATE message_jobs
      SET status = 'needs_reconcile', updated_at = now()
    WHERE id = $1 AND client_id = $2 AND status = 'processing'`;
}

// Same shape with a parameterized WHERE predicate instead of a literal one
// (`status = $status`) - proves PARAMETERIZED_STATUS_PATTERN's identical
// clause-bound fix, not just LITERAL_STATUS_PATTERN's. The SET clause here
// deliberately never touches `status` at all (only `updated_at`) - a SET
// clause that itself assigns `status = $newStatus` is a REAL parameterized
// claim-shape write and must keep flagging (see
// bad-named-param-claim.sql/bad-parameterized-claim.sql); this fixture is
// only about a WHERE-clause predicate using a parameter.
export function markNeedsReconcileParameterized(): string {
  return `UPDATE message_jobs
      SET updated_at = now()
    WHERE id = $1 AND client_id = $2 AND status = $status`;
}

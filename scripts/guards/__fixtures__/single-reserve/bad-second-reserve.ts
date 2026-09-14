// Fixture: a second, forbidden claim-style UPDATE embedded as a TS
// template literal - proves the guard scans string/template literal spans
// in TS/TSX files too, not just raw .sql files.
export function rogueReserve(): string {
  return `UPDATE pacing_ledger SET consumed_count = consumed_count + 1 WHERE instance_id = $1`;
}

// Parameterized-bind variant on a different tracked column - the RHS is
// unconstrained by design (see COLUMN_WRITE_PATTERN), so a bound parameter
// value flags exactly the same as a literal.
export function rogueReserveVariant(): string {
  return 'UPDATE pacing_ledger SET new_conv_count = $2 WHERE instance_id = $1';
}

// Fixture (finding 4b, P03 close): parameterized claim-style UPDATE - the
// literal 'processing' value would be bound as a query parameter in TS, not
// embedded in the SQL text itself, so LITERAL_STATUS_PATTERN alone can't see
// it. Proves PARAMETERIZED_STATUS_PATTERN catches `SET status = $N`
// co-occurring with message_jobs in the same span.
export function rogueParameterizedClaim(): string {
  return 'UPDATE message_jobs SET status = $1, updated_at = now() WHERE id = $2';
}

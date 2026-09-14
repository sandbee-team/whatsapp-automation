// Fixture (P03 close, finding 2a): a second claim-style UPDATE where an
// UNRELATED string literal earlier in the same statement (`lease_owner =
// 'a;b'`) contains a `;` character. The [^;]-bounded gap between SET and
// status='processing' must not be defeated by a semicolon that lives inside
// a SQL string literal, not at a real statement boundary.
export function rogueClaimWithSemicolonInsideString(): string {
  return `UPDATE message_jobs SET lease_owner = 'a;b', status = 'processing' WHERE id = $1`;
}

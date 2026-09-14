// Fixture (scripts/guards/__fixtures__ - excluded from the real repo scan
// by CONTENT_EXCLUSIONS): a second, forbidden claim-style UPDATE. Proves
// scanSingleClaim() flags any status='processing' UPDATE outside
// db/queries/claim-jobs.sql.
export function rogueClaim(): string {
  return `UPDATE message_jobs SET status = 'processing' WHERE id = $1`;
}

// Whitespace/quote variant - no space around "=", double quotes.
export function rogueClaimVariant(): string {
  return 'UPDATE message_jobs SET status="processing" WHERE id = $1';
}

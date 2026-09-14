// Known-bad/known-good fixture for check-tenant-scope.test.ts (P00 step 6).
// Excluded from every real scan (scripts/guards/__fixtures__/**).

export const listQueuedJobs = () => {
  return `SELECT * FROM message_jobs WHERE status = 'queued'`;
};

export const listQueuedJobsForClient = () => {
  return `SELECT * FROM message_jobs WHERE status = 'queued' AND client_id = $1`;
};

// Represents a legitimate platform-level read (e.g. the P02+ scheduler
// worklist scan) that must go through CROSS_TENANT_QUERIES to be exempt.
export const platformWorklistRead = () => {
  return `SELECT id FROM message_jobs WHERE next_attempt_at <= now()`;
};

// Reproduces the exact P09 drain.ts shape that surfaced the comment-quote
// misalignment bug: a JSDoc block comment containing an English possessive
// apostrophe ("caller's") AND markdown-style inline-code backticks
// immediately before a real multi-line template literal with a genuine
// `client_id` predicate. Before the stripComments fix, the apostrophe in
// the comment paired across the comment/code boundary with the closing
// quote of `'processing'` inside the real SQL several lines later, merging
// two unrelated spans and losing the `client_id` predicate from the span
// that matched the table name - a false positive, misattributed to the
// PRECEDING exported symbol. This fixture pins that this exact shape stays
// clean.
export const precedingSymbol = () => {
  return `noop`;
};

/**
 * Runs through the caller's own `tx: TenantQueryable` (already
 * `app.client_id`-scoped) - deliberately mirrors drain.ts's doc comment
 * shape (possessive apostrophe + inline-code backticks) directly above a
 * real multi-line UPDATE with a genuine client_id predicate.
 */
export const commentApostropheBeforeScopedUpdate = () => {
  return `UPDATE message_jobs
      SET status = 'needs_reconcile', updated_at = now()
    WHERE id = $1 AND client_id = $2 AND status = 'processing'`;
};

/**
 * Same comment shape (caller's, `backticks`) but the query below is
 * genuinely missing client_id - must still be flagged, and attributed to
 * THIS symbol, not `precedingSymbol` above. Proves the fix does not
 * introduce a false negative (comment stripping must never hide a real
 * missing predicate) or a false-attribution regression.
 */
export const commentApostropheBeforeUnscopedUpdate = () => {
  return `UPDATE message_jobs
      SET status = 'needs_reconcile', updated_at = now()
    WHERE id = $1 AND status = 'processing'`;
};

// Known-good fixture for check-copy.test.ts (P00 step 9).
// Excluded from every real scan (scripts/guards/__fixtures__/**).

// Good: only a generic lowercase "broadcast" in a code comment - the
// capitalized-token co-presence clause is case-SENSITIVE by design, so this
// must NOT be flagged (see check-copy.ts's capitalization-rule comment).
function broadcastQueueDepth(): number {
  // this helper computes queue depth for any broadcast-style fan-out job
  return 0;
}

export { broadcastQueueDepth };

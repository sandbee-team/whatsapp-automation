// Known-bad fixture for check-send-origin.test.ts (P00 step 7).
// Excluded from every real scan (scripts/guards/__fixtures__/**).
//
// Adversarial-evasion attempt: reference the exempt origin identifier as a
// quoted computed-property key rather than a bare identifier. The guard
// scans raw file TEXT, so a quoted occurrence still contains the identifier
// as a contiguous substring and must still be caught.

export function enqueueSystemMessage(payload: Record<string, unknown>): unknown {
  return payload['SYSTEM_REPLY'];
}

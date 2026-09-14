// Known-bad fixture for check-send-origin.test.ts (P00 step 7).
// Excluded from every real scan (scripts/guards/__fixtures__/**).
//
// Represents a worker referencing an exempt system-message origin outside
// modules/pacing/internal/ - invariant 6 violation (no pacing-bypass
// surface). Fed to scanSendOrigin() under a synthetic path mirroring
// app/backend/src/modules/queue/worker.service.ts.

import { isExemptOrigin } from '../../pacing/internal/exemptions';

export function enqueueAutoReply(candidateOrigin: string) {
  return { isExempt: isExemptOrigin(candidateOrigin) || candidateOrigin === SYSTEM_REPLY };
}

// Known-bad/known-good fixture for check-send-origin.test.ts (P00 step 7).
// Excluded from every real scan (scripts/guards/__fixtures__/**).

import { z } from 'zod';

// Bad: accepts `origin` from client input - a pacing-bypass surface.
export const sendMessageInputSchema = z.object({
  to: z.string(),
  origin: z.string(),
});

// Good: no `origin` field - must not be flagged.
export const sendMessageCleanSchema = z.object({
  to: z.string(),
  body: z.string(),
});

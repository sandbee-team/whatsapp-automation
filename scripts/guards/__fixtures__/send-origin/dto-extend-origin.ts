// Known-bad fixture for check-send-origin.test.ts (P00 step 7).
// Excluded from every real scan (scripts/guards/__fixtures__/**).
//
// Adversarial-evasion attempt: add the "origin" field via ".extend()" on a
// base z.object(...) schema, rather than directly inside the initial
// z.object({...}) call - the ZOD_ORIGIN_KEY regex scans raw line text and
// does not care which call the field sits inside, so this must still be
// caught (see check-send-origin.ts).

import { z } from 'zod';

const baseSchema = z.object({
  to: z.string(),
});

export const sendMessageExtendedSchema = baseSchema.extend({
  origin: z.string(),
});

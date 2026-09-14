import { z } from 'zod';
import { KEK_PURPOSES } from './purposes.js';

const kekPurposeSchema = z.enum(KEK_PURPOSES);

/**
 * Round-trips `material` through base64 -> Buffer -> base64 and checks the
 * decoded length is exactly 32 bytes (AES-256). `Buffer.from(x, 'base64')`
 * silently drops invalid trailing characters instead of throwing, so a
 * length-only check would let garbage like `"not-base64!!!"` through - the
 * round-trip re-encode catches that: garbage input never re-encodes back to
 * itself. Never touches `ctx` with the raw value - Zod's default issue
 * message would otherwise echo `x`.
 */
function isExactly32BytesOfBase64(value: string): boolean {
  let decoded: Buffer;
  try {
    decoded = Buffer.from(value, 'base64');
  } catch {
    return false;
  }
  if (decoded.length !== 32) {
    return false;
  }
  return decoded.toString('base64') === value;
}

const kekRecordSchema = z.object({
  purpose: kekPurposeSchema,
  material: z.string().refine(isExactly32BytesOfBase64, {
    message: 'material must be base64 of exactly 32 bytes',
  }),
  created_at: z.string(),
  retired: z.boolean().optional(),
});

const rawKeyRingSchema = z.object({
  version: z.literal(1),
  active: z.record(kekPurposeSchema, z.string()),
  keys: z.record(z.string(), kekRecordSchema),
});

/**
 * The key-ring file schema (data-security design §4.3). Cross-field checks
 * (every `active` pointer resolves, points at a key of the matching purpose,
 * and never points at a `retired` key) run in `superRefine` below - Zod's
 * per-field validators can't see across `active`/`keys`. Every issue names
 * the offending kekId/purpose; none ever includes `material`.
 */
export const keyRingSchema = rawKeyRingSchema.superRefine((ring, ctx) => {
  for (const [purpose, kekId] of Object.entries(ring.active)) {
    const key = ring.keys[kekId];
    if (!key) {
      ctx.addIssue({
        code: 'custom',
        message: `active.${purpose} references unknown kekId "${kekId}"`,
        path: ['active', purpose],
      });
      continue;
    }
    if (key.purpose !== purpose) {
      ctx.addIssue({
        code: 'custom',
        message: `active.${purpose} points at kekId "${kekId}" whose purpose is "${key.purpose}"`,
        path: ['active', purpose],
      });
    }
    if (key.retired === true) {
      ctx.addIssue({
        code: 'custom',
        message: `active.${purpose} points at kekId "${kekId}" which is retired`,
        path: ['active', purpose],
      });
    }
  }
});

export type KeyRing = z.infer<typeof rawKeyRingSchema>;

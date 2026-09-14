import { createHash } from 'node:crypto';
import { contentHashInput, type ContentHashFields } from '@wp/domain';

/**
 * content-hash.ts (P12 Unit U3, ADR 0035) - the Node-side digest half of
 * `content_hash`: `sha256(contentHashInput(fields))`, 32 bytes, stored in
 * `send_attempts.content_hash` / `message_wa_ids.content_hash` (both
 * `bytea`). `@wp/domain#contentHashInput` owns the pure canonicalisation
 * (must run in a browser, ships no `node:crypto` - see that module's own
 * header); this tiny wrapper is the one place `node:crypto` is allowed to
 * apply the digest.
 *
 * Both call sites (`dispatch.ts`'s `prepareAndIncrement` and
 * `modules/queue/echo-capture.ts`) MUST route through this function. A
 * second `createHash` call written independently at either site is exactly
 * how the two sides silently drift apart - see ADR 0035's own worked example
 * of the P11 defect this replaces.
 */
export function computeContentHash(fields: ContentHashFields): Buffer {
  return createHash('sha256').update(contentHashInput(fields), 'utf8').digest();
}

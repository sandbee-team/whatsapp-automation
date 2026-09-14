import { createHmac } from 'node:crypto';
import type { KeyProvider } from '@wp/server-kit/crypto';

/**
 * phone-hash.ts (P14 Unit U3 step 2; MOVED in P20 Unit U2 step 3 from
 * `modules/pacing/optout/hash.ts` - this is now the ONE implementation) -
 * `hashRecipient`, the ONE function that derives the hashed-recipient join
 * key stored in `opt_outs.phone_hash`, `message_jobs.recipient_hash`,
 * `recipient_send_buckets.phone_hash`, and (P20) `contacts.phone_hash`.
 * HMAC-SHA256 over `value` keyed by the `optout-pepper` KEK's raw material
 * (used DIRECTLY as HMAC key bytes - never via `seal()`/`open()`, see that
 * purpose's own doc comment in `packages/server-kit/src/config/schema.ts`).
 *
 * `value` contract: the E.164 string (e.g. `"+15550001111"`) for a contact
 * recipient, or the group JID (e.g. `"123456789-987654321@g.us"`) for a
 * `@g.us` recipient - callers never hash a bare local phone number or a
 * `@s.whatsapp.net` JID; the E.164 form is the canonical identity a contact
 * opt-out is scoped to, and the group JID is the canonical identity a group
 * job's `recipient_hash` collides against (see `registry.ts`'s
 * `cancelOptOutJobs` and its own doc on why group jobs are excluded from the
 * opt-out gate despite potentially sharing a hash value).
 *
 * This key is never retired/rotated (see the KEK purpose's own doc comment),
 * so - unlike envelope crypto - there is no "old key still works" path to
 * lean on here: `hashRecipient` always uses `getActive`, and that is
 * correct only because `optout-pepper` never rotates.
 */
export function hashRecipient(provider: KeyProvider, value: string): Buffer {
  const pepper = provider.getActive('optout-pepper').material;
  return createHmac('sha256', pepper).update(value, 'utf8').digest();
}

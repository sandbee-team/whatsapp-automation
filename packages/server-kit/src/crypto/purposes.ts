/**
 * KEK purposes - re-exported from `../config/schema.js`, the single authority
 * for this literal list (see that file's module doc comment). Nothing in
 * `crypto/` re-declares `'session' | 'tenant-secrets' | 'user-secrets'`.
 *
 * Purpose -> mount table (data-security design §4.3):
 *   session         -> worker containers only (WhatsApp session blobs)
 *   tenant-secrets  -> api + worker (per-tenant configuration secrets)
 *   user-secrets    -> api only (end-user secrets, e.g. dashboard credentials)
 *
 * A process only ever mounts the purposes its role needs - see
 * `FileKeyProvider`'s `mountedPurposes` constructor option, which drops key
 * material for every other purpose before it ever enters memory.
 */
export { KEK_PURPOSES, type KekPurpose } from '../config/schema.js';

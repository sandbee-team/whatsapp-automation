import { normalizeJidUser } from '../contacts/jid.js';

/**
 * ignore-jid.ts (P21 Unit U2, step 3) - the browser-pure filter that decides
 * whether an inbound event's JID should be dropped before it reaches any
 * persistence or opt-out path.
 *
 * Two scopes with DIFFERENT rules on purpose:
 * - `message`: an inbound chat message needs an attributable sender/chat, so
 *   an empty jid, a broadcast/newsletter jid, or a group jid NOT in the
 *   caller's `sendEnabledGroupJids` allowlist (empty until P24 wires it) is
 *   dropped.
 * - `receipt`: a delivery receipt (delivered/read/failed) is resolved by
 *   `wa_msg_id`, never by JID - so a missing jid or an un-allowlisted group
 *   jid must NOT be dropped. Only the platform-noise jids (status broadcast,
 *   newsletter) are ever dropped in this scope. The receipt branch returns
 *   immediately after that check and structurally never reads
 *   `sendEnabledGroupJids` (proven by
 *   `the_receipt_scope_never_consults_the_group_set`, which passes a `Set`
 *   subclass whose `has()` throws).
 */

export type InboundScope = 'message' | 'receipt';

export interface IgnoreJidOptions {
  scope: InboundScope;
  sendEnabledGroupJids: ReadonlySet<string>;
}

/** Case-insensitive server-part extraction; does not otherwise normalise the jid. */
function serverPartLower(jid: string): string {
  const sepIdx = jid.indexOf('@');
  if (sepIdx < 0) {
    return '';
  }
  return jid.slice(sepIdx + 1).toLowerCase();
}

function isStatusOrNewsletter(jid: string): boolean {
  const server = serverPartLower(jid);
  if (server === 'newsletter') {
    return true;
  }
  return jid.toLowerCase() === 'status@broadcast';
}

export function shouldIgnoreJid(
  jid: string | null | undefined,
  options: IgnoreJidOptions,
): boolean {
  const { scope, sendEnabledGroupJids } = options;

  if (!jid) {
    return scope === 'message';
  }

  if (isStatusOrNewsletter(jid)) {
    return true;
  }

  if (scope === 'receipt') {
    return false;
  }

  if (serverPartLower(jid) === 'g.us') {
    const normalisedGroupJid = normalizeJidUser(jid);
    return !sendEnabledGroupJids.has(normalisedGroupJid);
  }

  return false;
}

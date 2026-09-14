import { normalizeJidUser } from '../contacts/jid.js';

/**
 * group-jid.ts (P24 groups-messaging, Unit U2, step 1) - the group-JID
 * classifier and the ONE hash-input derivation for a group recipient.
 *
 * `isGroupJid` never inspects digits - a `@g.us` server suffix is the only
 * signal (same "never derive identity from digits" discipline as
 * `contacts/jid.ts`'s own header). `groupRecipientHashInput` returns
 * `normalizeJidUser(jid)` (device/agent suffix stripped, server lower-cased)
 * - this is the ONLY hash input for a group recipient; `app/backend` applies
 * `hashRecipient(keyProvider, groupRecipientHashInput(jid))`, the same
 * domain/backend split `queue/delivery-event-id.ts#providerEventIdInput`
 * uses (this package never touches `node:crypto`).
 */

const GROUP_SERVER = 'g.us';

/** True iff the server part (after the last `@`, case-insensitive) is `g.us`. Never inspects digits. */
export function isGroupJid(jid: string): boolean {
  const atIdx = jid.lastIndexOf('@');
  if (atIdx < 0) {
    return false;
  }
  return jid.slice(atIdx + 1).toLowerCase() === GROUP_SERVER;
}

/** Case-folds only the server part of `jid` (`user@SERVER` -> `user@server`); the user part is untouched (same helper `contacts/jid.ts#normaliseJid` uses internally). */
function lowerCaseServerOnly(jid: string): string {
  const sepIdx = jid.indexOf('@');
  if (sepIdx < 0) {
    return jid;
  }
  return `${jid.slice(0, sepIdx)}@${jid.slice(sepIdx + 1).toLowerCase()}`;
}

/**
 * The ONE hash input for a group recipient: the server-lower-cased jid run
 * through `normalizeJidUser` (device/agent suffix stripped). Throws
 * `RangeError` for anything that is not a group JID - a caller must never
 * hash a DM/broadcast/lid/newsletter JID through this function.
 */
export function groupRecipientHashInput(jid: string): string {
  if (!isGroupJid(jid)) {
    throw new RangeError(`groupRecipientHashInput: "${jid}" is not a @g.us group JID`);
  }
  return normalizeJidUser(lowerCaseServerOnly(jid));
}

/**
 * jid.ts (P20 Unit U2, step 3) - `normaliseJid`, the fail-safe classifier
 * that turns a Baileys-supplied JID into a durable-safe `{jid,
 * addressingMode, unattributable}` result. Ports `jidDecode`/`jidEncode`/
 * `jidNormalizedUser` from Baileys' own
 * `node_modules/baileys/lib/WABinary/jid-utils.js` (read verbatim: `user` and
 * `agent` split on `_`, `device` splits on `:`, and `jidNormalizedUser` folds
 * `@c.us` to `@s.whatsapp.net` - preserved here byte-for-byte, proven by
 * `app/backend/src/platform/crypto/jid-parity.test.ts` against the real
 * Baileys export).
 *
 * `normaliseJid` adds ONE deliberate superset on top of the ported
 * `normalizeJidUser`: it lower-cases the SERVER part only (`user@SERVER` ->
 * `user@server`) before decoding - the user part is untouched. Baileys itself
 * never lower-cases; this module does because a provider payload's casing is
 * not a semantic signal we want to key contact identity on.
 *
 * This module NEVER derives a lid<->pn mapping from digits - a `@lid` with no
 * caller-supplied `resolveLid` mapping is `unattributable`, never guessed
 * (core invariant 6 extended, see `optout-detect.ts`'s own doc on the same
 * rule).
 *
 * Deliberately separate from `queue/content-hash.ts#normalizeWaJidForHash`:
 * that function feeds a STORED content-hash fingerprint (strips `+`, ignores
 * `_agent`, keeps `@lid` unchanged) and must never change or every stored
 * fingerprint goes stale. This module answers a different question
 * (addressing mode + contact attribution) and must never be merged with it.
 */

export type AddressingMode = 'pn' | 'lid';

export interface JidResult {
  jid: string;
  addressingMode: AddressingMode;
  unattributable: boolean;
  e164: string | null;
  lidJid: string | null;
}

export interface NormaliseJidOptions {
  /** Returns the provider-supplied, persisted pn JID for a lid, or null if unmapped. Never a digit-derived guess. */
  resolveLid?: (normalisedLidJid: string) => string | null;
}

interface DecodedJid {
  user: string;
  server: string;
  device: string | undefined;
  agent: string | undefined;
}

/** Faithful port of Baileys' `jidDecode` (WABinary/jid-utils.js). Returns undefined when there is no `@`. */
function jidDecode(jid: string): DecodedJid | undefined {
  const sepIdx = jid.indexOf('@');
  if (sepIdx < 0) {
    return undefined;
  }
  const server = jid.slice(sepIdx + 1);
  const userCombined = jid.slice(0, sepIdx);
  const [userAgent, device] = userCombined.split(':');
  const [user, agent] = (userAgent ?? '').split('_');
  return { user: user ?? '', server, device, agent };
}

/** Faithful port of Baileys' `jidEncode`. */
function jidEncode(user: string, server: string, device?: string, agent?: string): string {
  const agentPart = agent ? `_${agent}` : '';
  const devicePart = device ? `:${device}` : '';
  return `${user}${agentPart}${devicePart}@${server}`;
}

/**
 * Faithful port of Baileys' `jidNormalizedUser`: decode, then re-encode with
 * `@c.us` folded to `@s.whatsapp.net`. Returns `''` when there is no `@`
 * (same as the Baileys original).
 */
export function normalizeJidUser(jid: string): string {
  const decoded = jidDecode(jid);
  if (!decoded) {
    return '';
  }
  const { user, server } = decoded;
  return jidEncode(user, server === 'c.us' ? 's.whatsapp.net' : server);
}

const ALL_DIGITS_RE = /^[0-9]+$/;

/** Case-folds only the server part of `jid` (`user@SERVER` -> `user@server`); the user part is untouched. */
function lowerCaseServerOnly(jid: string): string {
  const sepIdx = jid.indexOf('@');
  if (sepIdx < 0) {
    return jid;
  }
  return `${jid.slice(0, sepIdx)}@${jid.slice(sepIdx + 1).toLowerCase()}`;
}

const UNATTRIBUTABLE_RESULT_BASE = { unattributable: true, e164: null, lidJid: null } as const;

/**
 * Classifies a provider JID: lower-cases the server, applies
 * `normalizeJidUser`, then routes by server. `@s.whatsapp.net`/`@c.us` with an
 * all-digit user is a `pn` contact; anything else (non-digit user, `@g.us`,
 * `@broadcast`, `@newsletter`, `@hosted`, `@hosted.lid`, no `@`, empty) is
 * `unattributable` with `addressingMode: 'pn'` (there is no contact identity
 * to extract). `@lid` resolves through `options.resolveLid` ONLY - never a
 * digit-derived guess.
 */
export function normaliseJid(jid: string, options?: NormaliseJidOptions): JidResult {
  const caseFolded = lowerCaseServerOnly(jid);
  const normalised = normalizeJidUser(caseFolded);

  if (normalised === '') {
    return { jid: '', addressingMode: 'pn', ...UNATTRIBUTABLE_RESULT_BASE };
  }

  const decoded = jidDecode(normalised);
  const server = decoded?.server ?? '';
  const user = decoded?.user ?? '';

  if (server === 'lid') {
    const resolved = options?.resolveLid?.(normalised) ?? null;
    if (resolved !== null) {
      const resolvedResult = normaliseJid(resolved);
      return { ...resolvedResult, addressingMode: 'lid', lidJid: normalised };
    }
    return {
      jid: normalised,
      addressingMode: 'lid',
      unattributable: true,
      e164: null,
      lidJid: normalised,
    };
  }

  if (server === 's.whatsapp.net' && ALL_DIGITS_RE.test(user)) {
    return {
      jid: normalised,
      addressingMode: 'pn',
      unattributable: false,
      e164: `+${user}`,
      lidJid: null,
    };
  }

  return { jid: normalised, addressingMode: 'pn', ...UNATTRIBUTABLE_RESULT_BASE };
}

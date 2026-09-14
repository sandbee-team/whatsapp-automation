/**
 * pricing.ts - the closed set of price keys and the pure mapping from a
 * queued job's shape to the key that prices it. This is OUR pricing, not a
 * provider cost pass-through (ADR 0019 S11); the seeded rate_minor numbers
 * in migration 0004 are placeholders the founder replaces later. Pure (no
 * Date/Math.random - wp/domain-no-wallclock): the same input always maps to
 * the same key, forever.
 */

export const PRICE_KEYS = ['text', 'media', 'group_text', 'group_media'] as const;

export type PriceKey = (typeof PRICE_KEYS)[number];

export interface ResolvePriceKeyInput {
  payloadKind: string;
  recipientJid: string;
}

/**
 * group ⇔ `recipientJid` ends with `@g.us`; media ⇔ `payloadKind ===
 * 'media'`; everything else ('text', 'reply', or an unknown kind) prices as
 * text.
 */
export function resolvePriceKey(input: ResolvePriceKeyInput): PriceKey {
  const isGroup = input.recipientJid.endsWith('@g.us');
  const isMedia = input.payloadKind === 'media';

  if (isGroup) {
    return isMedia ? 'group_media' : 'group_text';
  }
  return isMedia ? 'media' : 'text';
}

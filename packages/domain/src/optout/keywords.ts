/**
 * Opt-out keyword list (P14 Unit U2, phase step 2).
 *
 * `PLATFORM_OPTOUT_KEYWORDS` is the code-owned, non-removable baseline
 * (blueprint list, verbatim) - a tenant can only ADD keywords, never remove
 * or shadow a platform one. `resolveOptOutKeywords` enforces that: it
 * normalises every tenant entry the same way as the platform list
 * (`normaliseOptOutText`, so the comparison is on the same footing the
 * matcher itself will use) and THROWS if a tenant entry collides with a
 * normalised platform keyword, rather than silently dropping it - a silent
 * drop would let a tenant believe they widened opt-out coverage when they
 * actually left a platform keyword's protection in place unnoticed, which
 * is harmless, but ALSO would hide a genuine attempt to shadow/remove one,
 * which core invariant 6 (no provider-evasion / no compliance-weakening
 * surface) does not allow to pass silently.
 */
import { normaliseOptOutText } from './normalise.js';

export const PLATFORM_OPTOUT_KEYWORDS: readonly string[] = Object.freeze([
  'stop',
  'stopall',
  'unsubscribe',
  'opt out',
  'optout',
  'remove me',
  'do not message',
  'dnd',
  'band karo',
  'band karo message',
  'mat bhejo',
  'rok do',
  'बंद करो',
  'रोको',
  'हटाओ',
]);

const NORMALISED_PLATFORM_KEYWORDS: ReadonlySet<string> = new Set(
  PLATFORM_OPTOUT_KEYWORDS.map(normaliseOptOutText),
);

export function resolveOptOutKeywords(tenantKeywords: readonly string[]): readonly string[] {
  const seen = new Set<string>(NORMALISED_PLATFORM_KEYWORDS);
  const resolved: string[] = [...PLATFORM_OPTOUT_KEYWORDS];

  for (const raw of tenantKeywords) {
    const normalised = normaliseOptOutText(raw);

    if (NORMALISED_PLATFORM_KEYWORDS.has(normalised)) {
      throw new Error(
        `resolveOptOutKeywords: tenant keyword "${raw}" normalises to a platform opt-out keyword ("${normalised}") - platform keywords may be added to, never removed or shadowed`,
      );
    }

    if (seen.has(normalised)) continue; // dedupe (including within the tenant list itself)
    seen.add(normalised);
    resolved.push(raw);
  }

  return Object.freeze(resolved);
}

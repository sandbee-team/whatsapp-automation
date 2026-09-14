/**
 * Blocked-word matching (P14 Unit U2, phase step 3 / content guards, safe-
 * mode design categories).
 *
 * `matchBlockedWord` returns ONLY the category, never the matched word or
 * entry - a return value that echoed the matched phrase would let a caller
 * build a filter-tuning oracle (send probe messages, read back exactly
 * which phrase tripped the filter, iterate around it). Leet-speak
 * substitutions are normalised on the body BEFORE matching (0->o, 1->i/l
 * ambiguity resolved to "i", 3->e, 4->a, 5->s, 7->t, @->a, $->s) so trivial
 * evasion ("s3nd me the 0tp") still matches the plain-text phrase. Matching
 * is whole-word/phrase (word-boundary), so a platform word inside a longer
 * innocent word (e.g. "loan" inside "loaned") never matches.
 */

export interface BlockedWordEntry {
  word: string;
  category: string;
}

/** Frozen, code-owned starter set - one clearly-abusive entry or two per category is enough. */
export const PLATFORM_BLOCKED_WORDS: readonly BlockedWordEntry[] = Object.freeze([
  Object.freeze({ word: 'share your card pin', category: 'payment_fraud' }),
  Object.freeze({ word: 'send payment to unlock', category: 'payment_fraud' }),
  Object.freeze({ word: 'send me the otp', category: 'otp_harvesting' }),
  Object.freeze({ word: 'share your otp', category: 'otp_harvesting' }),
  Object.freeze({ word: 'you have won a lottery', category: 'lottery_prize' }),
  Object.freeze({ word: 'lucky draw winner', category: 'lottery_prize' }),
  Object.freeze({ word: 'instant loan no documents', category: 'loan_shark' }),
  Object.freeze({ word: 'loan', category: 'loan_shark' }),
  Object.freeze({ word: 'explicit adult content', category: 'adult' }),
  Object.freeze({ word: 'nude photos', category: 'adult' }),
  Object.freeze({ word: 'buy fake documents', category: 'illegal_offer' }),
  Object.freeze({ word: 'sell counterfeit goods', category: 'illegal_offer' }),
]);

const LEET_MAP: Readonly<Record<string, string>> = {
  '0': 'o',
  '1': 'i',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
  '@': 'a',
  $: 's',
};

function deleetify(text: string): string {
  let out = '';
  for (const ch of text) {
    out += LEET_MAP[ch] ?? ch;
  }
  return out;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * `\b` only asserts at a word-char/non-word-char transition, so it can never
 * match when the phrase's own edge character is itself a non-word character
 * (e.g. the `)` ending "$100 (free)") - the phrase would then be silently
 * unmatchable even verbatim. Use `\b` only when that edge is a word
 * character; otherwise use a lookaround that is vacuously satisfied next to
 * a non-word edge, so punctuation-edged phrases still match without
 * loosening the boundary for word-char edges (leading/trailing whitespace
 * still required there, preserving "loan" not matching inside "loaned").
 */
function buildPhraseRegex(phrase: string): RegExp {
  const words = phrase.trim().split(/\s+/).map(escapeRegExp);
  const joined = words.join('\\s+');
  const leadsWithWordChar = /^\w/.test(phrase);
  const endsWithWordChar = /\w$/.test(phrase);
  const leading = leadsWithWordChar ? '\\b' : '(?<!\\w)';
  const trailing = endsWithWordChar ? '\\b' : '(?!\\w)';
  return new RegExp(`${leading}${joined}${trailing}`, 'i');
}

export function matchBlockedWord(
  body: string,
  entries: readonly BlockedWordEntry[],
): { category: string } | null {
  return matchPreparedBlockedWord(body, prepareBlockedWordEntries(entries));
}

/** A `BlockedWordEntry` with its phrase regex already compiled - see `prepareBlockedWordEntries`'s own doc (MINOR 14, P14 review-fix F2). */
export interface PreparedBlockedWordEntry {
  category: string;
  pattern: RegExp;
}

/**
 * Compiles every entry's phrase regex ONCE (MINOR 14, P14 review-fix F2) -
 * `matchBlockedWord` previously rebuilt every entry's `RegExp` on EVERY
 * call, and the guard pipeline (`modules/pacing/guards/blocked-words.ts`)
 * previously called it once per claimed job, re-fetching the tenant's own
 * `tenant_blocked_words` rows AND re-compiling the whole platform+tenant
 * entry list's regexes on every single job in a claim pass. Callers that
 * evaluate many jobs per pass (one instance/client per `claimAndReserve`
 * pass) should call this ONCE per pass and reuse the result via
 * `matchPreparedBlockedWord` for every job - never re-preparing per job.
 */
export function prepareBlockedWordEntries(
  entries: readonly BlockedWordEntry[],
): PreparedBlockedWordEntry[] {
  return entries.map((entry) => ({
    category: entry.category,
    pattern: buildPhraseRegex(deleetify(entry.word.toLowerCase())),
  }));
}

/** `matchBlockedWord`'s own matching logic, but over ALREADY-PREPARED entries (`prepareBlockedWordEntries`) - never recompiles a regex. Same return contract: only the category, never the matched word/entry. */
export function matchPreparedBlockedWord(
  body: string,
  prepared: readonly PreparedBlockedWordEntry[],
): { category: string } | null {
  const normalised = deleetify(body.toLowerCase());

  for (const entry of prepared) {
    if (entry.pattern.test(normalised)) {
      return { category: entry.category };
    }
  }

  return null;
}

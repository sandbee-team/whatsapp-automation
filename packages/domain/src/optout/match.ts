/**
 * Opt-out keyword matcher (P14 Unit U2, phase step 2).
 *
 * A message matches a keyword when the NORMALISED message either IS the
 * keyword, or STARTS WITH it as a token prefix (matching whole tokens, not
 * a substring - "stopwatch" must never match "stop") AND the whole message
 * is short (<= 4 tokens). The token-count ceiling exists so a keyword
 * appearing incidentally deep in a longer, unrelated sentence never counts
 * as an opt-out - "stop by tomorrow if you can" is 6 tokens and does not
 * match, even though it starts with "stop".
 */
import { normaliseOptOutText } from './normalise.js';

const MAX_PREFIX_MATCH_TOKENS = 4;

function tokens(text: string): string[] {
  const normalised = normaliseOptOutText(text);
  return normalised.length === 0 ? [] : normalised.split(' ');
}

function startsWithTokenPrefix(messageTokens: string[], keywordTokens: string[]): boolean {
  if (keywordTokens.length > messageTokens.length) return false;
  return keywordTokens.every((keywordToken, i) => messageTokens[i] === keywordToken);
}

export function matchOptOutKeyword(text: string, keywords: readonly string[]): string | null {
  const messageTokens = tokens(text);
  if (messageTokens.length === 0) return null;

  for (const keyword of keywords) {
    const keywordTokens = tokens(keyword);
    if (keywordTokens.length === 0) continue;

    const isExact =
      messageTokens.length === keywordTokens.length &&
      startsWithTokenPrefix(messageTokens, keywordTokens);
    if (isExact) return keyword;

    const isShortPrefix =
      messageTokens.length <= MAX_PREFIX_MATCH_TOKENS &&
      startsWithTokenPrefix(messageTokens, keywordTokens);
    if (isShortPrefix) return keyword;
  }

  return null;
}

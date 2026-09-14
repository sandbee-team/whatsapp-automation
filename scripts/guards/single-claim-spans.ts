/**
 * single-claim-spans.ts - comment-stripping + literal-span text-position
 * helpers split out of `single-claim-lib.ts` at FIX-P09-B for the max-lines
 * cap (mechanical extraction only; no logic change). `single-claim-lib.ts`
 * re-exports both so every existing import path keeps working unchanged.
 */

/**
 * Replaces `//` line comments and `/* ... *` + `/` block comments with
 * equal-length whitespace (newlines preserved, so `lineOfIndex` stays
 * correct against the ORIGINAL content). This guard's whole reason for
 * being is scanning EXECUTABLE string/template literals for a real bypass -
 * documentation prose describing that same shape (this file's own JSDoc is
 * full of it) is not code and must never be mistaken for it. Without this
 * step, `literalSpans`' naive (non-escape-aware) quote pairing can pair a
 * stray `'`/`"` inside one comment with an unrelated one inside a DIFFERENT
 * comment far below, manufacturing a phantom multi-line "string" spanning
 * unrelated prose - exactly the self-referential trap this file's own
 * heavily-quoted documentation ran into during hardening (finding 4, P03
 * close). Known limitation, accepted as out of scope for a best-effort
 * regex guard: a real string literal that itself contains `//` or `/* *`+`/`
 * (e.g. a URL) could be partially eaten - no such content exists in any
 * claim-style SQL/Drizzle call today.
 */
export function stripComments(content: string): string {
  return content.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (match) => match.replace(/[^\n]/g, ' '));
}

/** String/template literal spans (start index + inner text) in `content` - comments excluded, see `stripComments`. */
export function* literalSpans(content: string): Generator<{ index: number; text: string }> {
  const pattern = /`([^`]*)`|'([^']*)'|"([^"]*)"/g;
  const withoutComments = stripComments(content);
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(withoutComments)) !== null) {
    yield { index: match.index, text: match[1] ?? match[2] ?? match[3] ?? '' };
  }
}

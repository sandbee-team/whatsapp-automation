/**
 * tenant-scope-spans.ts - comment-stripping + literal-span text-position
 * helpers split out of `check-tenant-scope.ts` at FIX-P09-B for the
 * max-lines cap (mechanical extraction only; no logic change).
 */

const LITERAL_PATTERN = /`([^`]*)`|'([^']*)'|"([^"]*)"/g;

/**
 * Blanks out `//` line comments and `/* *‍/` block comments (JSDoc included)
 * in TS source, preserving every other character's index AND every newline
 * (so `enclosingSymbol`'s index-based attribution and line counts are
 * unaffected) - replaces comment characters with spaces, never deletes.
 *
 * WHY: `literalSpans` pairs quote characters naively
 * (`` `([^`]*)`|'([^']*)'|"([^"]*)" ``). English possessive apostrophes and
 * markdown-style inline-code backticks inside `/** *‍/` JSDoc comments (e.g.
 * "the caller's own `tx: ...`") are indistinguishable from real quote
 * delimiters to that regex, so a quote character in a comment can pair
 * across the comment/code boundary with an unrelated quote character
 * several lines later - INSIDE a real SQL template literal - producing a
 * merged, misaligned span that (a) can split a real predicate away from its
 * table reference (false positive, misattributed to the wrong enclosing
 * symbol) or (b) swallow an unrelated `client_id` substring into a bloated
 * merged span and mask a genuinely missing predicate (false negative). See
 * `.memory/lessons/` for the P09 drain.ts case that surfaced this. Comments
 * carry no runtime SQL, so blanking them before the literal-span scan
 * removes the entire class of quote-pairing-across-a-comment bugs.
 *
 * String/template literals are tracked so a `//` or `/*` occurring INSIDE a
 * real literal (e.g. a URL) is never mistaken for a comment start.
 */
export function stripComments(content: string): string {
  let out = '';
  let i = 0;
  const n = content.length;
  while (i < n) {
    const ch = content[i];
    const next = content[i + 1];

    // String/template literal: copy through verbatim (skipping escapes),
    // so a comment-looking sequence inside a literal is never blanked.
    if (ch === '`' || ch === "'" || ch === '"') {
      const quote = ch;
      out += ch;
      i += 1;
      while (i < n) {
        const c = content[i];
        out += c;
        if (c === '\\' && i + 1 < n) {
          out += content[i + 1];
          i += 2;
          continue;
        }
        i += 1;
        if (c === quote) break;
      }
      continue;
    }

    // Line comment: blank everything up to (not including) the newline.
    if (ch === '/' && next === '/') {
      while (i < n && content[i] !== '\n') {
        out += ' ';
        i += 1;
      }
      continue;
    }

    // Block comment (incl. JSDoc): blank everything, preserving newlines.
    if (ch === '/' && next === '*') {
      out += '  ';
      i += 2;
      while (i < n && !(content[i] === '*' && content[i + 1] === '/')) {
        out += content[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      if (i < n) {
        out += '  ';
        i += 2;
      }
      continue;
    }

    out += ch;
    i += 1;
  }
  return out;
}

/** Finds string/template literal spans (start index + inner text) in `content`. */
export function* literalSpans(content: string): Generator<{ index: number; text: string }> {
  const pattern = new RegExp(LITERAL_PATTERN.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    yield { index: match.index, text: match[1] ?? match[2] ?? match[3] ?? '' };
  }
}

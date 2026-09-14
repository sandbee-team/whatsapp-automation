import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import fg from 'fast-glob';
import { describe, expect, it } from 'vitest';

/**
 * Static tripwire (P25 U7 step 9, PII-gate defense-in-depth; widened in the
 * P25 C1 fix round, Finding 5): a `logger.<level>(...)` OR
 * `console.(log|info|warn|error)(...)` call whose raw text interpolates
 * `String(err)`/`err.message` (or any of its `error`/`e` spelling variants)
 * risks putting a pg error's `message`/`detail` - which routinely embeds
 * the offending row's own data, e.g. `Key (email)=(user@example.com)
 * already exists.` - straight into a structured log line, bypassing
 * `describeError`'s name+code-only summary entirely (the allow-list
 * `sanitizeFields` filter only inspects FIELD values, never the free-text
 * `msg` string - see logger.ts's own doc comment on that contract). Scan
 * roots: `app/backend/src/**` AND `packages/*\/src/**` (excluding
 * tests/support/fixtures/dist) - this scans the real source tree for the
 * raw text pattern rather than parsing an AST: cheap, and the point is
 * exactly to catch the raw text a human or future edit might reintroduce.
 */

const FORBIDDEN_SNIPPETS = [
  '${String(err',
  '${String(error',
  '${String(e)',
  '${err.message',
  '${error.message',
  '${e.message',
] as const;

const REPO_ROOT = join(__dirname, '..', '..', '..', '..', '..');

/** `logger.<level>(...)` OR `console.(log|info|warn|error)(...)` - both are log sinks. */
const LOG_CALL_START_PATTERN =
  /(?:logger\.(?:fatal|error|warn|info|debug|trace)|console\.(?:log|info|warn|error))\(/g;

/** Extracts every log-sink call's argument text, matching parens. */
function findLoggerCallArgs(text: string): string[] {
  const calls: string[] = [];
  const callStart = new RegExp(LOG_CALL_START_PATTERN.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = callStart.exec(text)) !== null) {
    const openParenIndex = match.index + match[0].length - 1;
    let depth = 0;
    let endIndex = -1;
    for (let i = openParenIndex; i < text.length; i += 1) {
      if (text[i] === '(') depth += 1;
      else if (text[i] === ')') {
        depth -= 1;
        if (depth === 0) {
          endIndex = i;
          break;
        }
      }
    }
    if (endIndex !== -1) {
      calls.push(text.slice(openParenIndex, endIndex + 1));
    }
  }
  return calls;
}

const SCAN_ROOT_GLOBS = ['app/backend/src/**/*.ts', 'packages/*/src/**/*.ts'];
const SCAN_IGNORE_GLOBS = [
  '**/__tests__/**',
  '**/__test-support__/**',
  '**/__fixtures__/**',
  '**/*.test.ts',
  '**/*.integration.test.ts',
  '**/dist/**',
];

async function scanRealTree(): Promise<{ file: string; snippet: string; call: string }[]> {
  const files = await fg(SCAN_ROOT_GLOBS, {
    cwd: REPO_ROOT,
    absolute: true,
    ignore: SCAN_IGNORE_GLOBS,
  });

  const hits: { file: string; snippet: string; call: string }[] = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    if (!text.includes('logger.') && !text.includes('console.')) continue;
    const calls = findLoggerCallArgs(text);
    for (const call of calls) {
      for (const snippet of FORBIDDEN_SNIPPETS) {
        if (call.includes(snippet)) {
          hits.push({ file, snippet, call });
        }
      }
    }
  }
  return hits;
}

describe('platform static tripwire: no raw error interpolation in logger/console calls', () => {
  it('the_real_source_tree_has_zero_raw_error_interpolations_in_logger_calls', async () => {
    const hits = await scanRealTree();
    if (hits.length > 0) {
      const list = hits.map((h) => `${h.file}: ${h.snippet} in "${h.call}"`).join('\n');
      throw new Error(`Found raw error interpolation(s) in logger calls:\n${list}`);
    }
    expect(hits).toEqual([]);
  });

  it('the_scanner_detects_a_planted_positive_control_fixture', () => {
    const plantedSource = 'logger.error({}, `boom: ${String(err)}`);';
    const calls = findLoggerCallArgs(plantedSource);
    const detected = calls.some((call) =>
      FORBIDDEN_SNIPPETS.some((snippet) => call.includes(snippet)),
    );
    expect(detected).toBe(true);
  });
});

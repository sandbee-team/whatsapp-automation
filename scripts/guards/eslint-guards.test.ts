import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ESLint } from 'eslint';
import type { Linter } from 'eslint';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from './registry.js';

/**
 * Proves the lint-level guards (P00 step 5, `packages/config/eslint.config.js`)
 * actually fire, by running ESLint's API against known-bad/known-good source
 * text drawn from `scripts/guards/__fixtures__/eslint/`. `lintText` is called
 * with a `filePath` that does NOT live under `scripts/guards/__fixtures__/**`
 * (that tree is excluded from the real lint run) - the fixture text is linted
 * "as if" it lived at a real workspace path, so flat-config `files`/`ignores`
 * scoping (the platform/redis exemption, the packages/domain scoping) applies
 * exactly as it would for real source.
 */

const CONFIG_PATH = path.join(REPO_ROOT, 'packages', 'config', 'eslint.config.js');
const FIXTURE_DIR = path.join(REPO_ROOT, 'scripts', 'guards', '__fixtures__', 'eslint');

function readFixture(name: string): string {
  return readFileSync(path.join(FIXTURE_DIR, name), 'utf8');
}

/** 1-based line number of the first line containing `marker`. */
function lineOf(code: string, marker: string): number {
  const idx = code.indexOf(marker);
  if (idx === -1) {
    throw new Error(`fixture marker not found: ${marker}`);
  }
  return code.slice(0, idx).split('\n').length;
}

async function lint(code: string, filePath: string): Promise<Linter.LintMessage[]> {
  const eslint = new ESLint({ overrideConfigFile: CONFIG_PATH, cwd: REPO_ROOT });
  const [result] = await eslint.lintText(code, { filePath });
  return result?.messages ?? [];
}

function linesFor(messages: Linter.LintMessage[], text: string): number[] {
  return messages
    .filter((message) => message.message.includes(text))
    .map((message) => message.line)
    .filter((line): line is number => line !== undefined && line !== null);
}

describe('eslint guard rules (fixture proof)', () => {
  it('a_plain_set_is_rejected_and_set_local_is_not', async () => {
    const code = readFixture('plain-set.ts');
    const messages = await lint(code, 'app/backend/src/fake-plain-set.ts');
    const flagged = linesFor(messages, 'wp/no-plain-set');

    expect(flagged).toContain(lineOf(code, 'badSetLiteral'));
    expect(flagged).toContain(lineOf(code, 'badSetTemplate'));
    expect(flagged).not.toContain(lineOf(code, 'goodSetLocal'));
    expect(flagged).not.toContain(lineOf(code, 'goodSetConfigLiteral'));
  });

  it('offset_pagination_is_rejected', async () => {
    const code = readFixture('offset-pagination.ts');
    const messages = await lint(code, 'app/backend/src/fake-offset-pagination.ts');
    const flagged = linesFor(messages, 'wp/no-offset-pagination');

    expect(flagged).toContain(lineOf(code, 'badOffsetLiteral'));
    expect(flagged).toContain(lineOf(code, 'badOffsetTemplate'));
    expect(flagged).toContain(lineOf(code, 'query.offset(40)'));
    expect(flagged).not.toContain(lineOf(code, 'goodKeysetLiteral'));
  });

  it('a_raw_wp_key_literal_outside_platform_redis_is_rejected', async () => {
    const code = readFixture('raw-wp-key.ts');
    const messages = await lint(code, 'app/backend/src/fake-raw-wp-key.ts');
    const flagged = linesFor(messages, 'wp/key-construction');

    expect(flagged).toContain(lineOf(code, 'badKeyLiteral'));
    expect(flagged).toContain(lineOf(code, 'badKeyTemplate'));
    expect(flagged).not.toContain(lineOf(code, 'goodKey'));

    // The same raw `wp:` literal, linted as if it lived inside platform/redis,
    // must NOT be flagged - that is the one place allowed to build keys.
    const exemptMessages = await lint(
      "export const key = 'wp:tenant:123:queue';",
      'app/backend/src/platform/redis/keys.ts',
    );
    expect(linesFor(exemptMessages, 'wp/key-construction')).toHaveLength(0);
  });

  // accepted limitation: see wp-key-concatenation.ts's file header. A `wp:`
  // key built by string concatenation is a BinaryExpression, not a Literal
  // starting with `wp:`, so neither KEY_ENTRIES selector can see it.
  it('a_wp_key_built_by_string_concatenation_evades_the_rule_accepted_limitation', async () => {
    const code = readFixture('wp-key-concatenation.ts');
    const messages = await lint(code, 'app/backend/src/fake-wp-key-concat.ts');
    const flagged = linesFor(messages, 'wp/key-construction');

    expect(flagged).toHaveLength(0);
  });

  it('lowercase_set_and_offset_keywords_are_still_rejected_case_insensitively', async () => {
    const code = readFixture('lowercase-set-offset.ts');
    const messages = await lint(code, 'app/backend/src/fake-lowercase-set-offset.ts');

    expect(linesFor(messages, 'wp/no-plain-set')).toContain(lineOf(code, 'badLowercaseSet'));
    expect(linesFor(messages, 'wp/no-offset-pagination')).toContain(
      lineOf(code, 'badLowercaseOffset'),
    );
  });

  it('date_now_and_math_random_inside_domain_are_rejected', async () => {
    const code = readFixture('domain-wallclock.ts');
    const messages = await lint(code, 'packages/domain/src/fake.ts');
    const flagged = linesFor(messages, 'wp/domain-no-wallclock');

    expect(flagged).toContain(lineOf(code, 'return Date.now();'));
    expect(flagged).toContain(lineOf(code, 'return Math.random();'));
    expect(flagged).toContain(lineOf(code, 'return new Date();'));
    expect(flagged).not.toContain(lineOf(code, 'return clock.now();'));
    expect(flagged).not.toContain(lineOf(code, 'return new Date(clock.now());'));

    // The very same code linted outside packages/domain must NOT be flagged -
    // the wall-clock ban is scoped to the pure domain package only.
    const outsideMessages = await lint(code, 'app/backend/src/fake-wallclock.ts');
    expect(linesFor(outsideMessages, 'wp/domain-no-wallclock')).toHaveLength(0);
  });
});

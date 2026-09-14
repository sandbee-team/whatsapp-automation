import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { en } from '@wp/i18n';
import { REPO_ROOT, resolveFiles } from './guards/scan-config.js';

/**
 * i18n-key-usage.test.ts (P26b C2 hardening) - greps every `t('<literal>')`
 * / `t("<literal>")` call site under `app/frontend/src` and asserts each key
 * exists in the `en` catalogue. A key referenced only via a template literal
 * (e.g. `` t(`realtime.${state}`) ``) is dynamic and cannot be membership-
 * checked here - those call sites are intentionally excluded, same as
 * `catalogue-parity.test.ts` only ever compares the STATIC key sets of `en`/
 * `hi` against each other, never against runtime-constructed keys.
 */

const CALL_PATTERN = /\bt\(\s*(['"])([a-zA-Z0-9_.]+)\1/g;

function tKeysUsedIn(filePath: string): string[] {
  const text = readFileSync(path.join(REPO_ROOT, filePath), 'utf8');
  const keys: string[] = [];
  for (const match of text.matchAll(CALL_PATTERN)) {
    const key = match[2];
    if (key) keys.push(key);
  }
  return keys;
}

describe("every t('...') literal used in app/frontend/src exists in the en catalogue", () => {
  it('scans a non-zero number of frontend source files', () => {
    const files = resolveFiles(['app/frontend/src/**/*.ts', 'app/frontend/src/**/*.tsx']);
    expect(files.length).toBeGreaterThan(0);
  });

  it('every statically-keyed t(...) call site resolves to a key the en catalogue declares', () => {
    const files = resolveFiles(['app/frontend/src/**/*.ts', 'app/frontend/src/**/*.tsx']);
    const enKeys = new Set(Object.keys(en));
    const missing: string[] = [];

    for (const file of files) {
      for (const key of tKeysUsedIn(file)) {
        if (!enKeys.has(key)) {
          missing.push(`${file}: ${key}`);
        }
      }
    }

    expect(
      missing,
      `t() literal keys missing from the en catalogue:\n${missing.join('\n')}`,
    ).toEqual([]);
  });
});

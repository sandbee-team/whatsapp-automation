import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor, InvalidCursorError } from './contacts-cursor.js';

/**
 * contacts.api.test.ts (P20 Unit U4, step 4) - PURE unit tests (no DB): the
 * "exactly one `hashRecipient` implementation" static scan (mirrors
 * `provider/baileys/logout-call-sites.test.ts`'s own recursive-scan idiom)
 * plus the cursor codec round-trip. No import here reaches `@wp/server-kit`'s
 * config singleton, so the `stub-wp-server-kit-env.js` first-import guard is
 * not needed (same precedent as `phone-hash.test.ts`).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = join(HERE, '..', '..');

const EXCLUDED_DIR_NAMES = new Set(['__tests__', '__test-support__', 'dist', 'node_modules']);

/** Recursively collects every `.ts` file under `root`, excluding test files and the excluded directory names. */
function collectSourceFiles(root: string): string[] {
  const entries = readdirSync(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;
    const fullPath = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(fullPath));
    } else if (entry.isFile() && fullPath.endsWith('.ts') && !fullPath.endsWith('.test.ts')) {
      files.push(fullPath);
    }
  }
  return files;
}

describe('exactly_one_phone_hash_implementation_exists', () => {
  it('only platform/crypto/phone-hash.ts defines createHmac + optout-pepper together', () => {
    const files = collectSourceFiles(SRC_ROOT);
    const matches: string[] = [];

    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      if (content.includes('createHmac(') && content.includes('optout-pepper')) {
        matches.push(relative(SRC_ROOT, file).split(sep).join('/'));
      }
    }

    expect(matches).toEqual(['platform/crypto/phone-hash.ts']);
  });

  it('modules/pacing/optout/hash.ts no longer exists (moved to phone-hash.ts)', () => {
    const files = collectSourceFiles(SRC_ROOT).map((f) =>
      relative(SRC_ROOT, f).split(sep).join('/'),
    );
    expect(files).not.toContain('modules/pacing/optout/hash.ts');
  });

  it('contacts.repo.ts references hashRecipient and never createHmac directly', () => {
    const content = readFileSync(
      join(SRC_ROOT, 'modules', 'contacts', 'contacts-write.ts'),
      'utf8',
    );
    expect(content).toContain('hashRecipient');
    expect(content).not.toContain('createHmac');
  });
});

describe('cursor_round_trips_and_rejects_garbage', () => {
  it('round trips an encoded cursor back to the same updatedAt/id', () => {
    const id = '11111111-1111-1111-1111-111111111111';
    const encoded = encodeCursor({ updatedAt: '2026-09-05T00:00:00.000Z', id });
    const decoded = decodeCursor(encoded);
    expect(decoded).toEqual({ updatedAt: '2026-09-05T00:00:00.000Z', id });
  });

  it('rejects a garbage cursor with InvalidCursorError', () => {
    expect(() => decodeCursor('not-a-real-cursor')).toThrow(InvalidCursorError);
    expect(() => decodeCursor(Buffer.from('no-separator-here').toString('base64url'))).toThrow(
      InvalidCursorError,
    );
  });
});

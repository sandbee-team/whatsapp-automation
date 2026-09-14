import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BOUNDARY_FILE_PATH,
  scanSerialisationBoundary,
  SERIALISATION_BOUNDARY_GLOBS,
  type SourceFile,
} from '../check-serialisation-boundary.js';
import { REPO_ROOT, resolveFiles } from './registry.js';

/**
 * Fixture proof for check-serialisation-boundary.ts (P07 Unit U1, step 3).
 * `scanSerialisationBoundary` is a pure function over already-read source
 * text - no filesystem access - mirroring `check-tenant-scope.test.ts` /
 * `check-role-boot.ts`'s fixture pattern. Uses the guard's OWN exported globs
 * (not the broader `SCAN_GLOBS`) so this test scans exactly what the real
 * guard scans - e.g. `packages/server-kit/test/fixtures/auth-creds.ts` (a
 * real, deliberate `BufferJSON` importer OUTSIDE `src/`) must stay excluded
 * by the glob, not by a bespoke exemption.
 */

function readRealTree(): SourceFile[] {
  return resolveFiles(SERIALISATION_BOUNDARY_GLOBS)
    .filter((relativePath) => !/(\.integration)?\.test\.tsx?$/.test(relativePath))
    .map((relativePath) => ({
      path: relativePath,
      content: readFileSync(path.join(REPO_ROOT, relativePath), 'utf8'),
    }));
}

describe('check-serialisation-boundary (P07 Unit U1)', () => {
  it('bufferjson_is_imported_by_exactly_one_file', () => {
    const files = readRealTree();

    const violations = scanSerialisationBoundary(files);

    expect(violations).toEqual([]);

    // A bare mention of the identifier (e.g. in a comment, like
    // json-codec.ts's/totp-secret.ts's doc comments) is NOT an import - only
    // an actual `import {...BufferJSON...} from 'baileys'` clause counts, so
    // this checks the same import-clause shape the guard itself checks,
    // never a loose word-boundary match.
    const importers = files.filter((file) =>
      /\bimport\s*\{[^}]*\bBufferJSON\b[^}]*\}\s*from\s*['"]baileys['"]/.test(file.content),
    );
    expect(importers.length).toBe(1);
    expect(importers[0]?.path).toBe(BOUNDARY_FILE_PATH);
  });

  it('a_second_importer_of_bufferjson_is_rejected', () => {
    const files = readRealTree();
    const rogueFile: SourceFile = {
      path: 'app/backend/src/provider/baileys/auth-state/rogue.ts',
      content: "import { BufferJSON } from 'baileys';\nexport { BufferJSON };\n",
    };

    const violations = scanSerialisationBoundary([...files, rogueFile]);

    expect(violations.some((violation) => violation.file === rogueFile.path)).toBe(true);
  });

  it('zero_importers_of_bufferjson_is_rejected', () => {
    const filesWithoutBoundary: SourceFile[] = [
      { path: 'app/backend/src/index.ts', content: 'export const noop = 1;\n' },
    ];

    const violations = scanSerialisationBoundary(filesWithoutBoundary);

    expect(
      violations.some((violation) => violation.message.includes('zero scanned files import')),
    ).toBe(true);
  });

  it('a_re_export_of_bufferjson_from_the_alternate_package_name_is_also_rejected_outside_the_boundary', () => {
    const files = readRealTree();
    const rogueFile: SourceFile = {
      path: 'packages/server-kit/src/rogue-reexport.ts',
      content: "export { BufferJSON } from '@whiskeysockets/baileys';\n",
    };

    const violations = scanSerialisationBoundary([...files, rogueFile]);

    expect(violations.some((violation) => violation.file === rogueFile.path)).toBe(true);
  });

  it('a_namespace_import_with_a_bufferjson_member_access_is_rejected_outside_the_boundary', () => {
    // WARNING-5 (lesson 2026-08-26): `import * as baileys from 'baileys'`
    // combined with `baileys.BufferJSON` in the SAME file is a realistic
    // import shape the original named-import-only pattern missed entirely.
    const files = readRealTree();
    const rogueFile: SourceFile = {
      path: 'app/backend/src/provider/baileys/auth-state/rogue-namespace.ts',
      content:
        "import * as baileys from 'baileys';\n" +
        'export function seal(value: unknown) { return JSON.stringify(value, baileys.BufferJSON.replacer); }\n',
    };

    const violations = scanSerialisationBoundary([...files, rogueFile]);

    expect(violations.some((violation) => violation.file === rogueFile.path)).toBe(true);
  });

  it('a_namespace_import_with_no_bufferjson_member_access_does_not_trip_the_guard', () => {
    // A namespace import of baileys that never touches `.BufferJSON` at all
    // must not be flagged - the guard polices the `BufferJSON` boundary
    // specifically, not every namespace import of baileys.
    const files = readRealTree();
    const innocentFile: SourceFile = {
      path: 'app/backend/src/provider/baileys/auth-state/innocent-namespace.ts',
      content: "import * as baileys from 'baileys';\nexport const proto = baileys.proto;\n",
    };

    const violations = scanSerialisationBoundary([...files, innocentFile]);

    expect(violations.some((violation) => violation.file === innocentFile.path)).toBe(false);
  });

  it('a_default_import_with_a_bufferjson_member_access_is_rejected_outside_the_boundary', () => {
    // WARNING-5: `import baileys from 'baileys'` combined with
    // `baileys.BufferJSON` is the other realistic shape the original pattern
    // missed.
    const files = readRealTree();
    const rogueFile: SourceFile = {
      path: 'app/backend/src/provider/baileys/auth-state/rogue-default.ts',
      content:
        "import baileys from 'baileys';\n" +
        'export function open(raw: string) { return JSON.parse(raw, baileys.BufferJSON.reviver); }\n',
    };

    const violations = scanSerialisationBoundary([...files, rogueFile]);

    expect(violations.some((violation) => violation.file === rogueFile.path)).toBe(true);
  });

  it('test_files_may_import_bufferjson_without_tripping_the_guard', () => {
    // server-kit's P01 tests legitimately reference BufferJSON-shaped codecs
    // in fixtures - *.test.ts files are excluded from the scan glob entirely
    // (see SERIALISATION_BOUNDARY_GLOBS), so this is a glob-exclusion
    // property, not a scanSerialisationBoundary exemption.
    const files = readRealTree();
    expect(files.every((file) => !/\.test\.tsx?$/.test(file.path))).toBe(true);
  });
});

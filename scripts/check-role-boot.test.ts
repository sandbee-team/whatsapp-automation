import { describe, expect, it } from 'vitest';
import { scanRoleBoot, type SourceFile } from './check-role-boot.js';

/**
 * Fixture proof for check-role-boot.ts (reviewer M5). `scanRoleBoot` is a
 * pure function over already-read source text - no filesystem access.
 */
describe('check-role-boot (reviewer M5)', () => {
  it('a_role_file_that_never_references_assertDbPreconditionsOrExit_is_a_violation', () => {
    const files: SourceFile[] = [
      { path: 'app/backend/src/roles/api.ts', content: 'export function main() {}' },
    ];

    const violations = scanRoleBoot(files);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.file).toBe('app/backend/src/roles/api.ts');
    expect(violations[0]?.message).toContain('assertDbPreconditionsOrExit');
  });

  it('a_role_file_that_references_assertDbPreconditionsOrExit_is_clean', () => {
    const files: SourceFile[] = [
      {
        path: 'app/backend/src/roles/api.ts',
        content:
          "import { assertDbPreconditionsOrExit } from '../platform/db/assert-db-preconditions.js';",
      },
    ];

    expect(scanRoleBoot(files)).toEqual([]);
  });

  it('migrate_ts_is_exempt_even_without_the_reference', () => {
    const files: SourceFile[] = [
      { path: 'app/backend/src/roles/migrate.ts', content: 'export function main() {}' },
    ];

    expect(scanRoleBoot(files)).toEqual([]);
  });

  it('a_nested_role_entrypoint_without_the_reference_is_a_violation', () => {
    const files: SourceFile[] = [
      { path: 'app/backend/src/roles/api/index.ts', content: 'export function main() {}' },
    ];

    const violations = scanRoleBoot(files);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.file).toBe('app/backend/src/roles/api/index.ts');
    expect(violations[0]?.message).toContain('assertDbPreconditionsOrExit');
  });

  it('a_nested_migrate_ts_is_not_exempt_by_name_alone', () => {
    const files: SourceFile[] = [
      { path: 'app/backend/src/roles/api/migrate.ts', content: 'export function main() {}' },
    ];

    const violations = scanRoleBoot(files);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.file).toBe('app/backend/src/roles/api/migrate.ts');
  });

  it('an_empty_file_list_flags_nothing', () => {
    expect(scanRoleBoot([])).toEqual([]);
  });
});

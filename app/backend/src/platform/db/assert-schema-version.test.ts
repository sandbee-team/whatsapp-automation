import { EXPECTED_SCHEMA_VERSION } from '@wp/db';
import { describe, expect, it, vi } from 'vitest';

import { assertDbPreconditionsOrExit } from './assert-db-preconditions.js';
import {
  assertSchemaVersion,
  SchemaVersionMismatchError,
  type Queryable,
} from './assert-schema-version.js';

function stubDb(rows: unknown[]): Queryable {
  return { query: vi.fn().mockResolvedValue({ rows }) };
}

function throwingDb(err: unknown): Queryable {
  return { query: vi.fn().mockRejectedValue(err) };
}

describe('assertSchemaVersion', () => {
  it('a_role_refuses_to_boot_when_the_database_is_behind_the_expected_version', async () => {
    const behind = stubDb([{ max_version: EXPECTED_SCHEMA_VERSION - 1 }]);
    await expect(assertSchemaVersion(behind)).rejects.toThrow(SchemaVersionMismatchError);

    const ahead = stubDb([{ max_version: EXPECTED_SCHEMA_VERSION + 1 }]);
    await expect(assertSchemaVersion(ahead)).rejects.toThrow(SchemaVersionMismatchError);

    const exit = vi.fn();
    const ok = await assertDbPreconditionsOrExit(behind, exit);
    expect(ok).toBe(false);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('wraps a query failure as a fail-closed SchemaVersionMismatchError', async () => {
    const broken = throwingDb(new Error('connection refused'));
    await expect(assertSchemaVersion(broken)).rejects.toThrow(SchemaVersionMismatchError);
  });

  it('resolves when the applied version exactly matches EXPECTED_SCHEMA_VERSION', async () => {
    const current = stubDb([{ max_version: EXPECTED_SCHEMA_VERSION }]);
    await expect(assertSchemaVersion(current)).resolves.toBeUndefined();
  });
});

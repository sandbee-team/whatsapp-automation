import { describe, expect, it } from 'vitest';
import { isPgUnavailableError } from './pg-unavailable.js';

/**
 * pg-unavailable.test.ts (P26 U6a) - table-driven classifier test, split out
 * of `creds-save-buffer.test.ts` purely to keep both files under the
 * workspace's `max-lines` cap (same idiom as `session-worker-discovery-
 * wiring.ts`'s sibling-module split) - no behaviour change.
 */

class FenceConflictErrorStub extends Error {
  constructor() {
    super('fence conflict');
    this.name = 'FenceConflictError';
  }
}

describe('isPgUnavailableError - table-driven classifier', () => {
  const cases: { name: string; err: unknown; expected: boolean }[] = [
    { name: 'SQLSTATE 57P01', err: { code: '57P01' }, expected: true },
    { name: 'SQLSTATE 57P02', err: { code: '57P02' }, expected: true },
    { name: 'SQLSTATE 57P03', err: { code: '57P03' }, expected: true },
    { name: 'SQLSTATE 08000', err: { code: '08000' }, expected: true },
    { name: 'SQLSTATE 08001', err: { code: '08001' }, expected: true },
    { name: 'SQLSTATE 08003', err: { code: '08003' }, expected: true },
    { name: 'SQLSTATE 08004', err: { code: '08004' }, expected: true },
    { name: 'SQLSTATE 08006', err: { code: '08006' }, expected: true },
    { name: 'SQLSTATE 53300', err: { code: '53300' }, expected: true },
    { name: 'Node ECONNREFUSED', err: { code: 'ECONNREFUSED' }, expected: true },
    { name: 'Node ECONNRESET', err: { code: 'ECONNRESET' }, expected: true },
    { name: 'Node ETIMEDOUT', err: { code: 'ETIMEDOUT' }, expected: true },
    { name: 'Node ENOTFOUND', err: { code: 'ENOTFOUND' }, expected: true },
    { name: 'Node EAI_AGAIN', err: { code: 'EAI_AGAIN' }, expected: true },
    { name: 'Node EPIPE', err: { code: 'EPIPE' }, expected: true },
    {
      name: 'message: connection terminated',
      err: { message: 'connection terminated unexpectedly' },
      expected: true,
    },
    {
      name: 'message: terminating connection',
      err: { message: 'terminating connection due to administrator command' },
      expected: true,
    },
    {
      name: 'message: timeout exceeded when trying to connect',
      err: { message: 'timeout exceeded when trying to connect' },
      expected: true,
    },
    {
      name: 'message: database system is shutting down',
      err: { message: 'FATAL: the database system is shutting down' },
      expected: true,
    },
    {
      name: 'message: database system is starting up',
      err: { message: 'FATAL: the database system is starting up' },
      expected: true,
    },
    { name: 'FenceConflictError', err: new FenceConflictErrorStub(), expected: false },
    {
      name: 'CredsSaveExhaustedError-shaped',
      err: { name: 'CredsSaveExhaustedError', message: 'exhausted retries' },
      expected: false,
    },
    { name: 'unique_violation 23505', err: { code: '23505' }, expected: false },
    { name: 'undefined_table 42P01', err: { code: '42P01' }, expected: false },
    { name: 'null', err: null, expected: false },
    { name: 'undefined', err: undefined, expected: false },
    { name: 'plain string', err: 'boom', expected: false },
    { name: 'unrelated message', err: { message: 'permission denied' }, expected: false },
  ];

  for (const { name, err, expected } of cases) {
    it(`classifies ${name} as ${String(expected)}`, () => {
      expect(isPgUnavailableError(err)).toBe(expected);
    });
  }
});

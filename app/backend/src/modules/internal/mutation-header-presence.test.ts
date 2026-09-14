import '../realtime/__test-support__/stub-wp-server-kit-env.js';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { parseMutationHeaders } from './internal-access.js';

/**
 * mutation-header-presence.test.ts (P28 Unit U3b, step 5) - pins the
 * 400-vs-403 split `internal-access.ts#parseMutationHeaders` documents, which
 * the phase safety-boundary test 11 depends on and which no test covered before.
 *
 * The split matters because the two answers mean different things to an
 * operator: a MISSING header is a malformed request (400, fix your client),
 * while a PRESENT but non-staff actor (`system`, `api_key:...`) is an
 * AUTHORIZATION refusal (403) - "/internal/v1 mutations are always a named
 * staff member acting". If `parseMutationHeaders` shape-checked `x-actor`
 * itself, `system` would come back as a 400 and the safety-boundary assertion
 * "a service actor is REFUSED" would be passing for the wrong reason (a
 * validation quibble rather than an authorization verdict), and would keep
 * passing even if the actor gate were later removed.
 *
 * A unit test (`*.test.ts`) whose import chain reaches `@wp/server-kit`, so
 * the env stub is the FIRST import (see core-invariants: the `config`
 * singleton parses `process.env` once per process).
 */

function reqWith(headers: Record<string, string | undefined>): FastifyRequest {
  return { headers } as unknown as FastifyRequest;
}

const KEY = randomUUID();

describe('parseMutationHeaders 400-vs-403 split', () => {
  it('a_well_formed_staff_actor_is_returned_unchanged', () => {
    const staffActor = `staff:${randomUUID()}`;
    expect(
      parseMutationHeaders(reqWith({ 'idempotency-key': KEY, 'x-actor': staffActor })),
    ).toEqual({ idempotencyKey: KEY, actor: staffActor });
  });

  it('a_non_staff_actor_passes_presence_so_the_403_verdict_stays_with_resolveStaffActor', () => {
    // These three are the safety-boundary 11 probes. They MUST parse here (no
    // ZodError -> no 400), so the request reaches `resolveStaffActor`, which
    // is what answers 403.
    for (const actor of ['system', `api_key:${randomUUID()}`, randomUUID()]) {
      expect(parseMutationHeaders(reqWith({ 'idempotency-key': KEY, 'x-actor': actor }))).toEqual({
        idempotencyKey: KEY,
        actor,
      });
    }
  });

  it('a_missing_or_blank_header_throws_so_the_route_answers_400_before_any_write', () => {
    const staffActor = `staff:${randomUUID()}`;
    expect(() => parseMutationHeaders(reqWith({ 'x-actor': staffActor }))).toThrow();
    expect(() => parseMutationHeaders(reqWith({ 'idempotency-key': KEY }))).toThrow();
    expect(() =>
      parseMutationHeaders(reqWith({ 'idempotency-key': '   ', 'x-actor': staffActor })),
    ).toThrow();
    expect(() =>
      parseMutationHeaders(reqWith({ 'idempotency-key': KEY, 'x-actor': '' })),
    ).toThrow();
  });
});

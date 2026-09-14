import { describe, expect, it } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { impersonationOf, isMetadataOnly, redactMessageBodies } from './impersonation-principal.js';

/**
 * impersonation-principal.test.ts (P28 Unit U3c) - unit coverage for
 * `redactMessageBodies`/`isMetadataOnly`/`impersonationOf`. Proves the
 * redaction contract directly (deep-strip, never a placeholder, arrays and
 * nested objects, primitives pass through) - see
 * `internal-impersonation-writes.integration.test.ts`'s own module doc for
 * why this codebase has no live HTTP route to exercise it against
 * end-to-end today.
 */

function reqWithAuth(auth?: {
  imp?: { grantId: string; scope: string; staffId: string };
}): FastifyRequest {
  return { auth } as unknown as FastifyRequest;
}

describe('impersonation-principal', () => {
  it('impersonationOf returns undefined for an ordinary session', () => {
    expect(impersonationOf(reqWithAuth())).toBeUndefined();
    expect(
      impersonationOf(
        reqWithAuth({ imp: undefined } as unknown as {
          imp?: { grantId: string; scope: string; staffId: string };
        }),
      ),
    ).toBeUndefined();
  });

  it('impersonationOf returns the imp claim when present', () => {
    const imp = { grantId: 'g1', scope: 'metadata_only', staffId: 's1' };
    expect(impersonationOf(reqWithAuth({ imp }))).toEqual(imp);
  });

  it('isMetadataOnly is true only for a metadata_only impersonation session', () => {
    expect(isMetadataOnly(reqWithAuth())).toBe(false);
    expect(
      isMetadataOnly(
        reqWithAuth({ imp: { grantId: 'g1', scope: 'metadata_only', staffId: 's1' } }),
      ),
    ).toBe(true);
    expect(
      isMetadataOnly(
        reqWithAuth({ imp: { grantId: 'g1', scope: 'with_message_bodies', staffId: 's1' } }),
      ),
    ).toBe(false);
  });

  it('redactMessageBodies deep-strips every forbidden key, removing (never placeholder-replacing) it', () => {
    const input = {
      id: 'msg-1',
      payload: { text: 'secret' },
      body: 'top-level secret',
      caption: 'media caption',
      content: 'generic content',
      quotedText: 'quoted secret',
      mediaUrl: 'https://example.test/secret.jpg',
      rawMessage: { anything: true },
      status: 'sent',
    };
    const redacted = redactMessageBodies(input);
    expect(redacted).toEqual({ id: 'msg-1', status: 'sent' });
    expect(Object.keys(redacted)).not.toContain('payload');
    expect(Object.keys(redacted)).not.toContain('body');
  });

  it('redactMessageBodies walks arrays and nested objects', () => {
    const input = {
      items: [
        { id: '1', payload: { text: 'a' }, meta: { caption: 'b', keep: 1 } },
        { id: '2', body: 'c' },
      ],
    };
    expect(redactMessageBodies(input)).toEqual({
      items: [{ id: '1', meta: { keep: 1 } }, { id: '2' }],
    });
  });

  it('redactMessageBodies leaves primitives, null, and unrelated keys untouched', () => {
    expect(redactMessageBodies(42)).toBe(42);
    expect(redactMessageBodies(null)).toBeNull();
    expect(redactMessageBodies('plain string')).toBe('plain string');
    expect(redactMessageBodies({ id: '1', count: 3 })).toEqual({ id: '1', count: 3 });
  });
});

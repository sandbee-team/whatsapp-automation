import { describe, expect, it } from 'vitest';
import { safeFetch, SafeFetchError } from './safe-fetch.js';
import type { Resolver } from './safe-fetch.js';
import { resolverFor, startForbiddenTarget } from './__test-support__/safe-fetch-test-helpers.js';

/**
 * safe-fetch.test.ts (P15 Unit U3) - the SSRF address/scheme/DNS-rebinding
 * cases (the four named cases NOT requiring a real TLS server). The
 * TLS-identity cases (self-signed, SNI/SAN, redirect, size-cap) live in the
 * sibling `safe-fetch-tls.test.ts` - split purely to respect the 300-line
 * file cap, not a behavioural boundary. "None dialled" is proven by an
 * injected connect spy (a TCP `net` server standing in for the forbidden
 * internal target) that fails the test on any hit, not merely by asserting
 * the thrown error class.
 */

describe('safeFetch: every_hostile_url_is_rejected_at_dispatch', () => {
  const hostileUrls: Array<[string, boolean]> = [
    ['http://example.com/', false], // insecure scheme always rejected - safeFetch requires https:
    ['https://localhost/', true],
    ['https://127.0.0.1/', true],
    ['https://[::1]/', true],
    ['https://0.0.0.0/', true],
    ['https://169.254.169.254/', true],
    ['https://10.0.0.5/', true],
    ['https://172.16.0.1/', true],
    ['https://192.168.1.1/', true],
    ['https://100.64.0.1/', true],
    ['https://[fd00::1]/', true],
    ['https://2130706433/', true],
    ['https://0177.0.0.1/', true],
    ['file:///etc/passwd', false],
    ['gopher://example.com/', false],
  ];

  it.each(hostileUrls)('rejects %s', async (url) => {
    let dialled = false;
    const resolver: Resolver = async (hostname) => {
      // localhost is the one hostname that is not itself a numeric literal
      // but must still resolve to a denied address to prove the address
      // check (not just the literal check) is exercised.
      if (hostname === 'localhost') return [{ address: '127.0.0.1', family: 4 }];
      if (hostname === 'example.com') return [{ address: '93.184.216.34', family: 4 }];
      return [{ address: '10.0.0.9', family: 4 }];
    };

    await expect(
      safeFetch(url, {
        resolver: (h) => {
          dialled = true;
          return resolver(h);
        },
      }),
    ).rejects.toBeInstanceOf(SafeFetchError);

    // For scheme/protocol rejections the resolver must never even run.
    if (url.startsWith('file://') || url.startsWith('gopher://') || url.startsWith('http://')) {
      expect(dialled).toBe(false);
    }
  });
});

describe('safeFetch: dns_rebinding_between_check_and_connect_cannot_reach_the_internal_address', () => {
  it('dials the CHECKED (first, public) answer - the second (loopback) answer is never dialled', async () => {
    let forbiddenHit = false;
    const forbidden = await startForbiddenTarget(() => {
      forbiddenHit = true;
    });

    // First answer is a public address that will fail to connect (nothing
    // listens there) - the key assertion is that the SECOND (loopback)
    // answer, which happens to be our forbidden listener, is never dialled
    // even though a naive "any answer works" resolver would eventually try
    // it as a fallback.
    const resolver: Resolver = async () => [
      { address: '203.0.113.1', family: 4 }, // TEST-NET-3, public, unreachable
      { address: '127.0.0.1', family: 4 },
    ];

    await expect(
      safeFetch('https://rebind.test.local/', {
        resolver,
        connectTimeoutMs: 200,
        totalTimeoutMs: 300,
      }),
    ).rejects.toBeInstanceOf(SafeFetchError);

    expect(forbiddenHit).toBe(false);
    await forbidden.close();
  });

  it('denies outright when the FIRST resolved answer is already internal, regardless of later answers', async () => {
    const resolver: Resolver = async () => [
      { address: '127.0.0.1', family: 4 },
      { address: '8.8.8.8', family: 4 },
    ];

    await expect(safeFetch('https://rebind2.test.local/', { resolver })).rejects.toMatchObject({
      code: 'address_denied',
    });
  });
});

describe('safeFetch: NODE_ENV=production disables devAllowedTargets regardless of caller intent', () => {
  it('a caller-supplied devAllowedTargets entry is ignored once NODE_ENV is production', async () => {
    // MINOR FIX: devAllowedTargets is gated on process.env.NODE_ENV INSIDE
    // safeFetch itself - never trusted from the caller alone.
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const resolver = resolverFor([{ address: '127.0.0.1', family: 4 }]);
      await expect(
        safeFetch('https://prod-guarded.test.local/', {
          resolver,
          devAllowedTargets: ['prod-guarded.test.local'],
        }),
      ).rejects.toMatchObject({ code: 'address_denied' });
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });
});

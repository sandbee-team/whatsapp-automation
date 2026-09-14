import tls from 'node:tls';
import { afterEach, describe, expect, it } from 'vitest';
import { safeFetch, SafeFetchError } from './safe-fetch.js';
import type { SafeFetchOptions } from './safe-fetch.js';
import {
  CA_CERT,
  LEAF_CERT,
  LEAF_KEY,
  SELF_SIGNED_CERT,
  SELF_SIGNED_KEY,
  startTlsFixtureServer,
  WRONG_HOST_CERT,
  WRONG_HOST_KEY,
} from './__test-support__/tls-fixture-server.js';
import type { TlsFixtureServer } from './__test-support__/tls-fixture-server.js';
import { resolverFor, startForbiddenTarget } from './__test-support__/safe-fetch-test-helpers.js';

/**
 * safe-fetch-tls.test.ts (P15 Unit U3, sibling of safe-fetch.test.ts split
 * purely to respect the 300-line file cap) - the TLS-identity named cases:
 * self-signed rejection, SNI/SAN pinned to the original hostname, redirect
 * refusal, and the 1 MB response cap. Every server here is a real
 * `node:tls` listener bound to `127.0.0.1:0` (ephemeral) using the
 * repo-local `__fixtures__/tls/*.pem` test-only CA/leaf certificates -
 * certificate verification is never disabled to make these pass (see
 * `scripts/check-no-insecure-tls.ts`); the CLIENT trusts the fixture CA via
 * `safeFetch`'s `ca` option instead.
 */

let liveServers: TlsFixtureServer[] = [];

afterEach(async () => {
  await Promise.all(liveServers.map((s) => s.close()));
  liveServers = [];
});

describe('safeFetch: a_self_signed_endpoint_is_rejected_and_verification_is_never_disabled', () => {
  it('rejects a self-signed (non-CA-issued) certificate', async () => {
    const server = await startTlsFixtureServer(SELF_SIGNED_CERT, SELF_SIGNED_KEY);
    liveServers.push(server);

    const resolver = resolverFor([{ address: '127.0.0.1', family: 4 }]);

    await expect(
      safeFetch(`https://safe-fetch.test.local:${String(server.port)}/`, {
        resolver,
        devAllowedTargets: [
          `safe-fetch.test.local:${String(server.port)}`,
          'safe-fetch.test.local',
        ],
        ca: CA_CERT,
        connectTimeoutMs: 2000,
        totalTimeoutMs: 3000,
      }),
    ).rejects.toBeInstanceOf(SafeFetchError);
  });

  it('no bypass option exists on SafeFetchOptions to disable verification', () => {
    // Type-level guarantee: assigning an object with 'rejectUnauthorized'
    // directly to SafeFetchOptions triggers excess-property checking and
    // fails to compile - proving the type has no such escape hatch.
    const options: SafeFetchOptions = {
      resolver: resolverFor([{ address: '127.0.0.1', family: 4 }]),
      devAllowedTargets: ['safe-fetch.test.local'],
      // @ts-expect-error -- rejectUnauthorized must not exist on SafeFetchOptions
      rejectUnauthorized: false,
    };
    expect(Object.keys(options)).toContain('rejectUnauthorized');
  });
});

describe('safeFetch: sni_and_certificate_identity_come_from_the_original_hostname_not_the_ip', () => {
  it('a valid cert for the hostname over an IP connection succeeds', async () => {
    const server = await startTlsFixtureServer(LEAF_CERT, LEAF_KEY);
    liveServers.push(server);

    const resolver = resolverFor([{ address: '127.0.0.1', family: 4 }]);

    const response = await safeFetch(`https://safe-fetch.test.local:${String(server.port)}/`, {
      resolver,
      devAllowedTargets: [`safe-fetch.test.local:${String(server.port)}`, 'safe-fetch.test.local'],
      ca: CA_CERT,
      connectTimeoutMs: 2000,
      totalTimeoutMs: 3000,
    });

    expect(response.statusCode).toBe(200);
    expect(server.connectionCount()).toBe(1);
  });

  it('a mismatched SAN (cert issued for a different hostname) fails', async () => {
    const server = await startTlsFixtureServer(WRONG_HOST_CERT, WRONG_HOST_KEY);
    liveServers.push(server);

    const resolver = resolverFor([{ address: '127.0.0.1', family: 4 }]);

    await expect(
      safeFetch(`https://safe-fetch.test.local:${String(server.port)}/`, {
        resolver,
        devAllowedTargets: [
          `safe-fetch.test.local:${String(server.port)}`,
          'safe-fetch.test.local',
        ],
        ca: CA_CERT,
        connectTimeoutMs: 2000,
        totalTimeoutMs: 3000,
      }),
    ).rejects.toBeInstanceOf(SafeFetchError);
  });
});

describe('safeFetch: a_redirect_to_an_internal_address_is_not_followed', () => {
  it('a 302 response is reported as an error and no second (internal) request is issued', async () => {
    let forbiddenHit = false;
    const forbidden = await startForbiddenTarget(() => {
      forbiddenHit = true;
    });

    const redirectServer = tls.createServer({ cert: LEAF_CERT, key: LEAF_KEY }, (socket) => {
      socket.on('data', () => {
        socket.write(
          `HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:${String(forbidden.port)}/\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`,
        );
        socket.end();
      });
    });
    await new Promise<void>((resolve, reject) => {
      redirectServer.once('error', reject);
      redirectServer.listen(0, '127.0.0.1', () => resolve());
    });
    const address = redirectServer.address();
    if (address === null || typeof address === 'string') throw new Error('no address');
    const redirectPort = address.port;

    const resolver = resolverFor([{ address: '127.0.0.1', family: 4 }]);

    await expect(
      safeFetch(`https://safe-fetch.test.local:${String(redirectPort)}/`, {
        resolver,
        devAllowedTargets: [
          `safe-fetch.test.local:${String(redirectPort)}`,
          'safe-fetch.test.local',
        ],
        ca: CA_CERT,
        connectTimeoutMs: 2000,
        totalTimeoutMs: 3000,
      }),
    ).rejects.toMatchObject({ code: 'redirect_not_followed' });

    expect(forbiddenHit).toBe(false);

    await new Promise<void>((resolve) => redirectServer.close(() => resolve()));
    await forbidden.close();
  });
});

describe('safeFetch: the pinned Host header can never be overridden by a caller header', () => {
  it('a caller-supplied Host header is ignored - the pinned original-hostname Host wins', async () => {
    // BUG FIX (minor, safe-fetch-dispatch.ts:98-101): the pinned `Host`
    // header used to be spread BEFORE `...params.headers`, so a
    // caller-supplied `Host` entry silently overrode the pinned value -
    // exactly the SSRF-relevant header the DNS-rebinding guard exists to
    // control (Host drives many origin servers' own virtual-host routing,
    // independent of the IP actually dialled).
    let capturedHostHeader: string | undefined;
    const server = tls.createServer({ cert: LEAF_CERT, key: LEAF_KEY }, (socket) => {
      let buffer = '';
      socket.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        const headerEnd = buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) return;
        const hostLine = buffer
          .slice(0, headerEnd)
          .split('\r\n')
          .find((line) => line.toLowerCase().startsWith('host:'));
        capturedHostHeader = hostLine?.split(':').slice(1).join(':').trim();
        socket.write('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}');
        socket.end();
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no address');
    const port = address.port;
    liveServers.push({
      port,
      connectionCount: () => 0,
      close: () => new Promise((res, rej) => server.close((err) => (err ? rej(err) : res()))),
    });

    const resolver = resolverFor([{ address: '127.0.0.1', family: 4 }]);

    await safeFetch(`https://safe-fetch.test.local:${String(port)}/`, {
      resolver,
      devAllowedTargets: [`safe-fetch.test.local:${String(port)}`, 'safe-fetch.test.local'],
      ca: CA_CERT,
      connectTimeoutMs: 2000,
      totalTimeoutMs: 3000,
      // An attacker/caller-supplied Host header attempting to override the
      // pinned original-hostname value.
      headers: { Host: 'attacker-controlled.example' },
    });

    expect(capturedHostHeader).toBe(`safe-fetch.test.local:${String(port)}`);
  });
});

describe('safeFetch: a_response_larger_than_one_megabyte_is_aborted', () => {
  it('aborts the connection once the cap is exceeded and does not buffer the full body', async () => {
    const CAP = 1024; // small injected cap - never a real 1MB wait in a test
    const CHUNK = Buffer.alloc(256, 'a');

    let bytesWrittenBeforeClose = 0;
    const bigServer = tls.createServer({ cert: LEAF_CERT, key: LEAF_KEY }, (socket) => {
      socket.on('data', () => {
        socket.write(`HTTP/1.1 200 OK\r\nContent-Length: 999999999\r\nConnection: close\r\n\r\n`);
        const interval = setInterval(() => {
          if (socket.destroyed) {
            clearInterval(interval);
            return;
          }
          socket.write(CHUNK);
          bytesWrittenBeforeClose += CHUNK.length;
          if (bytesWrittenBeforeClose > CAP * 20) {
            // Safety valve in case the client never aborts - stop the loop
            // so the test can still fail cleanly instead of hanging.
            clearInterval(interval);
            socket.end();
          }
        }, 1);
      });
      socket.on('error', () => undefined);
    });

    await new Promise<void>((resolve, reject) => {
      bigServer.once('error', reject);
      bigServer.listen(0, '127.0.0.1', () => resolve());
    });
    const address = bigServer.address();
    if (address === null || typeof address === 'string') throw new Error('no address');
    const port = address.port;

    const resolver = resolverFor([{ address: '127.0.0.1', family: 4 }]);

    await expect(
      safeFetch(`https://safe-fetch.test.local:${String(port)}/`, {
        resolver,
        devAllowedTargets: [`safe-fetch.test.local:${String(port)}`, 'safe-fetch.test.local'],
        ca: CA_CERT,
        maxResponseBytes: CAP,
        connectTimeoutMs: 2000,
        totalTimeoutMs: 3000,
      }),
    ).rejects.toMatchObject({ code: 'response_too_large' });

    // Proves the abort happened close to the cap, not after buffering the
    // entire (near-infinite) declared Content-Length.
    expect(bytesWrittenBeforeClose).toBeLessThan(CAP * 20);

    await new Promise<void>((resolve) => bigServer.close(() => resolve()));
  });
});

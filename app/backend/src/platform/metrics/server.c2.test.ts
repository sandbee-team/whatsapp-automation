import '../../modules/realtime/__test-support__/stub-wp-server-kit-env.js';
import { createMetricsRegistry } from '@wp/server-kit';
import { describe, expect, it, vi } from 'vitest';
import { startMetricsServer, ALL_INTERFACES_BINDS, type MetricsServerHandle } from './server.js';

/**
 * server.c2.test.ts (P25 SESSION-PROTOCOL C2 edge-case pass) - the hunt-list
 * cases not already covered by server.test.ts: close() during an in-flight
 * request, non-GET/unknown-path requests, IPv6 loopback bind forms, and a
 * broken collector's metricsText() rejection.
 */

async function closeAll(...handles: (MetricsServerHandle | undefined)[]): Promise<void> {
  for (const handle of handles) {
    if (handle) await handle.close();
  }
}

describe('close_during_an_in_flight_metrics_request', () => {
  it('a request already in flight when close() is called still completes with its response', async () => {
    const registry = createMetricsRegistry();
    // A slow-resolving metricsText() lets us call close() while the request
    // handler is still awaiting it, deterministically (no timers/sleeps).
    // `enteredHandler` resolves the instant the in-flight request's
    // metricsText() call actually starts, so close() is only invoked once
    // the request is provably in flight (no ECONNREFUSED race against the
    // TCP handshake).
    let releaseMetricsText: (() => void) | undefined;
    const slowText = new Promise<void>((resolve) => {
      releaseMetricsText = resolve;
    });
    let signalEntered: (() => void) | undefined;
    const enteredHandler = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    const slowRegistry = {
      ...registry,
      metricsText: async () => {
        signalEntered?.();
        await slowText;
        return 'wp_probe_total 1\n';
      },
    };

    const handle = await startMetricsServer({
      bind: '127.0.0.1',
      port: 0,
      role: 'api',
      env: 'test',
      registry: slowRegistry,
    });
    try {
      const address = handle.address();
      const fetchPromise = fetch(`http://127.0.0.1:${String(address?.port)}/metrics`);

      // Close only once the handler has provably started (metricsText()
      // entered), i.e. the request is genuinely in flight.
      await enteredHandler;
      const closePromise = handle.close();
      releaseMetricsText?.();

      const res = await fetchPromise;
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('wp_probe_total 1');
      await closePromise;
    } finally {
      await closeAll(handle);
    }
  });
});

describe('non_get_and_unknown_path_requests_never_crash_the_listener', () => {
  it('POST /metrics 404s rather than being served or crashing', async () => {
    const registry = createMetricsRegistry();
    const handle = await startMetricsServer({
      bind: '127.0.0.1',
      port: 0,
      role: 'api',
      env: 'test',
      registry,
    });
    try {
      const address = handle.address();
      const base = `http://127.0.0.1:${String(address?.port)}`;

      const postRes = await fetch(`${base}/metrics`, { method: 'POST', body: 'irrelevant' });
      expect(postRes.status).toBe(404);

      // The listener survives a body-bearing request and still serves a
      // subsequent GET correctly.
      const getRes = await fetch(`${base}/metrics`);
      expect(getRes.status).toBe(200);
    } finally {
      await closeAll(handle);
    }
  });

  it('a GET with a query string on an unknown path 404s, not a crash', async () => {
    const registry = createMetricsRegistry();
    const handle = await startMetricsServer({
      bind: '127.0.0.1',
      port: 0,
      role: 'api',
      env: 'test',
      registry,
    });
    try {
      const address = handle.address();
      const res = await fetch(`http://127.0.0.1:${String(address?.port)}/metrics?foo=bar`);
      // Exact-path match: '/metrics?foo=bar' !== '/metrics' at the req.url
      // level, so this 404s - pinning the exact (not prefix) match semantic.
      expect(res.status).toBe(404);
    } finally {
      await closeAll(handle);
    }
  });
});

describe('loopback_ipv6_and_whitespace_bind_forms_in_production', () => {
  it('accepts ::1 (IPv6 loopback) in production - not on the all-interfaces list', async () => {
    const registry = createMetricsRegistry();
    const handle = await startMetricsServer({
      bind: '::1',
      port: 0,
      role: 'api',
      env: 'production',
      registry,
    });
    try {
      expect(handle.address()).not.toBeNull();
    } finally {
      await closeAll(handle);
    }
  });

  it('accepts [::1] (bracketed IPv6 loopback) in production - only the bracketed ALL-interfaces form [::] is refused', async () => {
    const registry = createMetricsRegistry();
    const handle = await startMetricsServer({
      bind: '[::1]',
      port: 0,
      role: 'api',
      env: 'production',
      registry,
    });
    try {
      // Node's own listen() accepts the bracketed literal and normalises it
      // - this is not on ALL_INTERFACES_BINDS (only the bracketed
      // ALL-interfaces form "[::]" is), so production must accept it.
      expect(handle.address()).not.toBeNull();
    } finally {
      await closeAll(handle);
    }
  });

  it('"0.0.0.0 " with trailing whitespace is NOT recognised as all-interfaces (pinned, not a false negative gap)', () => {
    // ALL_INTERFACES_BINDS is an exact-match list; a value with incidental
    // whitespace is a distinct string, so it deliberately falls through to
    // Node's own bind behaviour rather than this module's refusal. Pinning
    // the exact-match contract so a future "trim before compare" change is a
    // conscious decision, not an accidental behaviour change.
    expect(ALL_INTERFACES_BINDS.includes('0.0.0.0 ')).toBe(false);
  });
});

describe('a_broken_registry_metricsText_rejection_is_a_500_not_a_crash', () => {
  it('the listener answers 500 with an empty body and stays up for the next request', async () => {
    const registry = createMetricsRegistry();
    let shouldFail = true;
    const brokenRegistry = {
      ...registry,
      metricsText: async () => {
        if (shouldFail) throw new Error('SENTINEL_COLLECTOR_BROKEN');
        return registry.metricsText();
      },
    };

    const handle = await startMetricsServer({
      bind: '127.0.0.1',
      port: 0,
      role: 'api',
      env: 'test',
      registry: brokenRegistry,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    try {
      const address = handle.address();
      const base = `http://127.0.0.1:${String(address?.port)}`;

      const failedRes = await fetch(`${base}/metrics`);
      expect(failedRes.status).toBe(500);
      expect(await failedRes.text()).toBe('');

      shouldFail = false;
      const recoveredRes = await fetch(`${base}/metrics`);
      expect(recoveredRes.status).toBe(200);
    } finally {
      await closeAll(handle);
    }
  });
});

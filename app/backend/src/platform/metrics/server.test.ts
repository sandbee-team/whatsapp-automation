import '../../modules/realtime/__test-support__/stub-wp-server-kit-env.js';
import net from 'node:net';
import path from 'node:path';
import fg from 'fast-glob';
import { readFile } from 'node:fs/promises';
import { createMetricsRegistry } from '@wp/server-kit';
import { describe, expect, it, vi } from 'vitest';
import {
  startMetricsServer,
  MetricsBindRefusedError,
  ALL_INTERFACES_BINDS,
  type MetricsServerHandle,
} from './server.js';

/**
 * server.test.ts (P25 U2, step 3) - unit-level proof that the metrics
 * listener is (a) structurally unreachable from the public API router and
 * (b) behaviourally correct in isolation (production bind refusal, registry
 * text + role-labelled default metrics, best-effort post-boot bind failure,
 * idempotent close). The real-app `app.inject('/metrics') -> 404` assertion
 * lands in P25 unit U7's integration test, not here.
 */

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..', '..');

async function closeAll(...handles: (MetricsServerHandle | undefined)[]): Promise<void> {
  for (const handle of handles) {
    if (handle) await handle.close();
  }
}

describe('metrics_listener_is_not_reachable_from_the_public_api_router', () => {
  it('no http route file declares the literal /metrics path', async () => {
    const files = await fg(
      ['app/backend/src/platform/http/**/*.ts', 'app/backend/src/modules/**/*.routes.ts'],
      { cwd: REPO_ROOT, absolute: true },
    );
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const content = await readFile(file, 'utf8');
      expect(content.includes("'/metrics'")).toBe(false);
      expect(content.includes('"/metrics"')).toBe(false);
    }
  });

  it('the metrics-only listener serves /metrics but 404s every other route', async () => {
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
      expect(address).not.toBeNull();
      const base = `http://127.0.0.1:${String(address?.port)}`;

      const metricsRes = await fetch(`${base}/metrics`);
      expect(metricsRes.status).toBe(200);

      const messagesRes = await fetch(`${base}/v1/messages`);
      expect(messagesRes.status).toBe(404);

      const rootRes = await fetch(`${base}/`);
      expect(rootRes.status).toBe(404);
    } finally {
      await closeAll(handle);
    }
  });
});

describe('production_refuses_to_bind_metrics_to_all_interfaces', () => {
  it('rejects 0.0.0.0 and :: in production before opening a socket', async () => {
    const registry = createMetricsRegistry();
    await expect(
      startMetricsServer({ bind: '0.0.0.0', port: 0, role: 'api', env: 'production', registry }),
    ).rejects.toBeInstanceOf(MetricsBindRefusedError);
    await expect(
      startMetricsServer({ bind: '::', port: 0, role: 'api', env: 'production', registry }),
    ).rejects.toBeInstanceOf(MetricsBindRefusedError);
  });

  it('allows loopback in production', async () => {
    const registry = createMetricsRegistry();
    const handle = await startMetricsServer({
      bind: '127.0.0.1',
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

  it('allows 0.0.0.0 in development', async () => {
    const registry = createMetricsRegistry();
    const handle = await startMetricsServer({
      bind: '0.0.0.0',
      port: 0,
      role: 'api',
      env: 'development',
      registry,
    });
    try {
      expect(handle.address()).not.toBeNull();
    } finally {
      await closeAll(handle);
    }
  });

  it('ALL_INTERFACES_BINDS names every all-interfaces bind checked above', () => {
    expect(ALL_INTERFACES_BINDS).toContain('0.0.0.0');
    expect(ALL_INTERFACES_BINDS).toContain('::');
  });
});

describe('serves_the_registry_text_with_default_metrics_labelled_by_role', () => {
  it('body carries the probe counter, a role-labelled default metric, and no role on the probe', async () => {
    const registry = createMetricsRegistry();
    const probe = registry.counter('wp_u2_probe_total', 'probe');
    probe.inc();

    const handle = await startMetricsServer({
      bind: '127.0.0.1',
      port: 0,
      role: 'api',
      env: 'test',
      registry,
    });
    try {
      const address = handle.address();
      const res = await fetch(`http://127.0.0.1:${String(address?.port)}/metrics`);
      expect(res.headers.get('content-type')).toBe('text/plain; version=0.0.4; charset=utf-8');

      const body = await res.text();
      expect(body).toContain('wp_u2_probe_total 1');
      expect(/(?:process_|nodejs_)\w+\{[^}]*role="api"[^}]*\}/.test(body)).toBe(true);

      const probeLine = body
        .split('\n')
        .find((line) => line.startsWith('wp_u2_probe_total') && !line.startsWith('#'));
      expect(probeLine).toBeDefined();
      expect(probeLine).not.toContain('role=');
    } finally {
      await closeAll(handle);
    }
  });
});

describe('default_metrics_are_registered_once_per_registry', () => {
  it('starting twice on the same registry does not throw', async () => {
    const registry = createMetricsRegistry();
    const first = await startMetricsServer({
      bind: '127.0.0.1',
      port: 0,
      role: 'api',
      env: 'test',
      registry,
    });
    await first.close();

    const second = await startMetricsServer({
      bind: '127.0.0.1',
      port: 0,
      role: 'api',
      env: 'test',
      registry,
    });
    await closeAll(second);
  });
});

describe('a_bind_failure_after_boot_is_logged_and_tolerated', () => {
  it('resolves a null-address handle and logs EADDRINUSE without a stack', async () => {
    const occupied = net.createServer();
    await new Promise<void>((resolve, reject) => {
      occupied.once('error', reject);
      occupied.listen(0, '127.0.0.1', () => resolve());
    });
    const occupiedPort = (occupied.address() as net.AddressInfo).port;

    const registry = createMetricsRegistry();
    const error = vi.fn();
    const handle = await startMetricsServer({
      bind: '127.0.0.1',
      port: occupiedPort,
      role: 'api',
      env: 'test',
      registry,
      logger: { info: vi.fn(), warn: vi.fn(), error },
    });

    try {
      expect(handle.address()).toBeNull();
      expect(error).toHaveBeenCalledTimes(1);
      const [, message] = error.mock.calls[0] as [unknown, string];
      expect(message).toContain('EADDRINUSE');
      expect(message).not.toContain('    at ');
    } finally {
      await closeAll(handle);
      await new Promise<void>((resolve) => occupied.close(() => resolve()));
    }
  });
});

describe('close_is_idempotent', () => {
  it('closing twice does not throw', async () => {
    const registry = createMetricsRegistry();
    const handle = await startMetricsServer({
      bind: '127.0.0.1',
      port: 0,
      role: 'api',
      env: 'test',
      registry,
    });
    await handle.close();
    await expect(handle.close()).resolves.toBeUndefined();
  });

  it('closing a handle that never listened (production refusal) does not throw', async () => {
    const registry = createMetricsRegistry();
    await expect(
      startMetricsServer({ bind: '0.0.0.0', port: 0, role: 'api', env: 'production', registry }),
    ).rejects.toBeInstanceOf(MetricsBindRefusedError);
  });
});

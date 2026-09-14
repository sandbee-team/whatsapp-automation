import http from 'node:http';
import { collectDefaultMetrics } from 'prom-client';
import { metrics as defaultMetrics, logger as defaultLogger } from '@wp/server-kit';
import type { MetricsRegistry, WpLogger } from '@wp/server-kit';

/**
 * platform/metrics/server.ts (P25 U2, step 3) - a SEPARATE `node:http`
 * listener per role, serving the shared `prom-client` registry text plus
 * prom-client's own default process/runtime metrics. NEVER mounted on the
 * public Fastify API router (`platform/http/**`): a tenant request must
 * never be able to reach `/metrics` - this listener binds its own socket on
 * its own port instead.
 *
 * Best-effort by design (core invariants 2/5): a monitoring endpoint that
 * fails to bind after boot (EADDRINUSE, EACCES, ...) is logged and
 * tolerated, never a reason to stop a role from sending. The ONE exception
 * is the production all-interfaces refusal below, which is a boot/config
 * error (fails before any socket opens, same class as a bad env var) rather
 * than a runtime fault - `main().catch` in each role prints name+message
 * and exits 1, which is the intended behaviour there.
 */

export interface MetricsServerOptions {
  bind: string;
  port: number;
  role: string;
  /** The app's NODE_ENV ('development' | 'test' | 'production'). */
  env: string;
  /** Default: the shared `metrics` export from `@wp/server-kit`. */
  registry?: MetricsRegistry;
  /** Default: the shared `logger` export from `@wp/server-kit`. */
  logger?: Pick<WpLogger, 'info' | 'warn' | 'error'>;
  /** Default true - registers prom-client's default process/runtime metrics. */
  collectDefaults?: boolean;
}

export interface MetricsServerHandle {
  address(): { host: string; port: number } | null;
  close(): Promise<void>;
}

export class MetricsBindRefusedError extends Error {
  constructor(bind: string) {
    super(
      `refusing to bind the metrics listener to all interfaces ("${bind}") in production - ` +
        'WP_METRICS_BIND must be a loopback or container-private address',
    );
    this.name = 'MetricsBindRefusedError';
  }
}

/** Every bind value this module treats as "all interfaces". */
export const ALL_INTERFACES_BINDS: readonly string[] = ['0.0.0.0', '::', '[::]', ''];

/**
 * Default-metrics registration is per-`Registry`, module-level, so a second
 * `startMetricsServer` call against the SAME registry (e.g. a restart, or
 * two roles sharing the shared `metrics` singleton in a test process) never
 * throws prom-client's duplicate-registration error.
 */
const defaultsRegisteredFor = new WeakSet<MetricsRegistry['registry']>();

function ensureDefaultMetrics(registry: MetricsRegistry, role: string): void {
  if (defaultsRegisteredFor.has(registry.registry)) return;
  collectDefaultMetrics({ register: registry.registry, labels: { role } });
  defaultsRegisteredFor.add(registry.registry);
}

function errorCode(err: NodeJS.ErrnoException): string {
  return err.code ?? err.name ?? 'UNKNOWN';
}

export async function startMetricsServer(opts: MetricsServerOptions): Promise<MetricsServerHandle> {
  if (opts.env === 'production' && ALL_INTERFACES_BINDS.includes(opts.bind)) {
    throw new MetricsBindRefusedError(opts.bind);
  }

  const registry = opts.registry ?? defaultMetrics;
  const log = opts.logger ?? defaultLogger;
  if (opts.collectDefaults ?? true) {
    ensureDefaultMetrics(registry, opts.role);
  }

  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/metrics') {
      registry
        .metricsText()
        .then((text) => {
          res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
          res.end(text);
        })
        .catch((err: unknown) => {
          // A broken collector must never hang the request or crash the
          // process (core invariant 2 applied to observability itself): log
          // and answer 500 with an empty body, same best-effort contract as
          // a post-boot bind failure above.
          log.error({}, `metrics scrape failed (${errorCode(err as NodeJS.ErrnoException)})`);
          if (!res.headersSent) {
            res.writeHead(500);
          }
          res.end();
        });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.requestTimeout = 5_000;
  server.headersTimeout = 2_000;
  server.keepAliveTimeout = 5_000;

  let listening = false;

  await new Promise<void>((resolve) => {
    server.once('error', (err: NodeJS.ErrnoException) => {
      log.error(
        {},
        `metrics listener not started (${errorCode(err)}) - continuing without a scrape endpoint`,
      );
      resolve();
    });
    server.listen({ host: opts.bind, port: opts.port, exclusive: true }, () => {
      listening = true;
      resolve();
    });
  });

  return {
    address: () => {
      if (!listening) return null;
      const addr = server.address();
      if (addr === null || typeof addr === 'string') return null;
      return { host: addr.address, port: addr.port };
    },
    close: async () => {
      if (!listening) return;
      listening = false;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

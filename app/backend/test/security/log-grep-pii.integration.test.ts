const captured = vi.hoisted(() => ({ lines: [] as string[] }));

vi.mock('@wp/server-kit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@wp/server-kit')>();
  const { Writable } = await import('node:stream');
  const stream = new Writable({
    write(chunk: Buffer | string, _enc, cb) {
      captured.lines.push(String(chunk));
      cb();
    },
  });
  return { ...actual, logger: actual.createLogger(stream) };
});

import { randomUUID } from 'node:crypto';
import { describeError } from '@wp/server-kit';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startMetricsServer, type MetricsServerHandle } from '../../src/platform/metrics/server.js';
import {
  allSentinelForms,
  buildWorkloadHandles,
  closeWorkloadHandles,
  makeSentinels,
  runTenantWorkload,
  type WorkloadHandles,
} from './pii-workload.js';

/**
 * log-grep-pii.integration.test.ts (P25 U7 Part B) - the blueprint's
 * mandatory end-to-end log-grep test: no seeded PII (phone/body/email/"API
 * key" = the session access token + refresh cookie - v1 has no `api_keys`
 * table) ever reaches a captured log line, the `/metrics` scrape, or an
 * `audit_logs`/`outbox_events` row, across two independent tenants, real
 * Postgres/Redis, and the real production HTTP app. Console output is also
 * captured (roles/error-mapper use `console` in a few boot-only paths) so
 * this is a genuine end-to-end grep, not just a pino-stream grep.
 *
 * There is NO `api_keys` table in v1 (tenant API auth is the session access
 * token + refresh cookie, minted at login) - the "API key" sentinel this
 * suite's mandate refers to is therefore the bearer access token itself; it
 * is asserted never to appear in a log line the same way every other
 * sentinel is.
 */

let handlesA: WorkloadHandles;
let handlesB: WorkloadHandles;
let metricsServer: MetricsServerHandle;
const consoleLines: string[] = [];
const consoleOriginals = {
  log: console.log,
  info: console.info,
  warn: console.warn,
  error: console.error,
};

beforeAll(async () => {
  for (const level of ['log', 'info', 'warn', 'error'] as const) {
    console[level] = (...args: unknown[]) => {
      consoleLines.push(args.map((a) => String(a)).join(' '));
    };
  }
  handlesA = await buildWorkloadHandles();
  handlesB = await buildWorkloadHandles();
  metricsServer = await startMetricsServer({
    bind: '127.0.0.1',
    port: 0,
    role: 'test',
    env: 'test',
    registry: handlesA.registry,
  });
});

afterAll(async () => {
  console.log = consoleOriginals.log;
  console.info = consoleOriginals.info;
  console.warn = consoleOriginals.warn;
  console.error = consoleOriginals.error;
  await metricsServer.close();
  await closeWorkloadHandles(handlesA);
  await closeWorkloadHandles(handlesB);
});

describe('PII gate - end-to-end log grep (P25 U7 Part B, real Postgres/Redis)', () => {
  it('no_seeded_phone_body_email_or_api_key_in_logs_metrics_or_audit_metadata', async () => {
    const sentinelsA = makeSentinels('a');
    const sentinelsB = makeSentinels('b');

    const resultA = await runTenantWorkload(handlesA, sentinelsA);
    const resultB = await runTenantWorkload(handlesB, sentinelsB);

    const forms = [
      ...allSentinelForms([sentinelsA, sentinelsB]),
      resultA.mfaAccessToken,
      resultB.mfaAccessToken,
    ];

    // Exactly one real log line per tenant: `message-signals.ts`'s own
    // `onOptedOut` error-log call site, deliberately triggered by this
    // workload's throwing port (see `runTenantWorkload`'s own comment) - the
    // ONE call site on this whole happy-path route that legitimately logs
    // with a seeded client id. Production logging is deliberately sparse by
    // design here (PII discipline, ADR 0021: the fewer call sites that ever
    // touch a logger, the smaller the leak surface) - asserting a much
    // higher floor would force fabricating log volume unrelated to any real
    // code path, which is not evidence of anything. Exact value, not a
    // bound, per this repo's own units-and-quantities convention.
    expect(captured.lines.length).toBe(2);

    const logText = captured.lines.join('\n');
    const consoleText = consoleLines.join('\n');
    const address = metricsServer.address();
    expect(address).not.toBeNull();
    const scrapeText = await (
      await fetch(`http://127.0.0.1:${String(address?.port)}/metrics`)
    ).text();

    const auditRows = await handlesA.pool.query<{ metadata: string | null }>(
      'SELECT metadata::text FROM audit_logs WHERE client_id = ANY($1)',
      [[resultA.clientId, resultB.clientId]],
    );
    const auditText = auditRows.rows.map((r) => r.metadata ?? '').join('\n');

    const outboxRows = await handlesA.pool.query<{ payload: string }>(
      'SELECT payload::text FROM outbox_events WHERE client_id = ANY($1)',
      [[resultA.clientId, resultB.clientId]],
    );
    const outboxText = outboxRows.rows.map((r) => r.payload).join('\n');

    for (const sentinel of forms) {
      if (logText.includes(sentinel)) {
        const offending = captured.lines.find((l) => l.includes(sentinel));
        throw new Error(`sentinel "${sentinel}" found in a log line: ${offending}`);
      }
      if (consoleText.includes(sentinel)) {
        const offending = consoleLines.find((l) => l.includes(sentinel));
        throw new Error(`sentinel "${sentinel}" found in console output: ${offending}`);
      }
      expect(scrapeText.includes(sentinel)).toBe(false);
      expect(auditText.includes(sentinel)).toBe(false);
      expect(outboxText.includes(sentinel)).toBe(false);
    }

    expect(scrapeText).toContain('wp_');
    expect(logText.includes(resultA.clientId) || logText.includes(resultB.clientId)).toBe(true);

    const publicApiScrape = await handlesA.app.inject({ method: 'GET', url: '/metrics' });
    expect(publicApiScrape.statusCode).toBe(404);
  });

  it('a_postgres_error_detail_never_reaches_a_log_line', async () => {
    const { logger } = await import('@wp/server-kit');
    captured.lines.length = 0;
    const sentinelA = `SENTINEL_PGERR_${randomUUID()}`;

    let syntaxErr: unknown;
    try {
      await handlesA.pool.query('SELECT $1::int', [sentinelA]);
    } catch (err) {
      syntaxErr = err;
    }
    expect(syntaxErr).toBeDefined();
    expect((syntaxErr as Error).message).toContain(sentinelA);

    logger.error({}, `probe failed: ${describeError(syntaxErr)}`);
    logger.error({ err: syntaxErr } as never, 'probe failed');

    const sentinelB = `sentinel-dup-${randomUUID()}@example.test`;
    await handlesA.pool.query(
      'INSERT INTO users (id, full_name, email, password_hash, email_verified_at) VALUES (gen_random_uuid(), $1, $2, $3, now())',
      ['PG Error Probe', sentinelB, 'x'],
    );
    let uniqueErr: unknown;
    try {
      await handlesA.pool.query(
        'INSERT INTO users (id, full_name, email, password_hash) VALUES (gen_random_uuid(), $1, $2, $3)',
        ['PG Error Probe', sentinelB, 'x'],
      );
    } catch (err) {
      uniqueErr = err;
    }
    await handlesA.pool.query('DELETE FROM users WHERE email = $1', [sentinelB]);
    expect(uniqueErr).toBeDefined();
    expect((uniqueErr as { detail?: string }).detail).toContain(sentinelB);

    logger.error({}, `probe failed: ${describeError(uniqueErr)}`);
    logger.error({ err: uniqueErr } as never, 'probe failed');

    const logText = captured.lines.join('\n');
    expect(logText).not.toContain(sentinelA);
    expect(logText).not.toContain(sentinelB);
    expect(logText).toContain('22P02');
    expect(logText).toContain('23505');
  });

  it('qr_and_pairing_payloads_never_appear_in_the_scrape', async () => {
    const sentinels = makeSentinels('qr-only');
    const result = await runTenantWorkload(handlesA, sentinels);

    const address = metricsServer.address();
    const scrapeText = await (
      await fetch(`http://127.0.0.1:${String(address?.port)}/metrics`)
    ).text();
    expect(scrapeText.includes(sentinels.qrPayload)).toBe(false);

    const outboxRows = await handlesA.pool.query<{ payload: string }>(
      'SELECT payload::text FROM outbox_events WHERE client_id = $1',
      [result.clientId],
    );
    for (const row of outboxRows.rows) {
      expect(row.payload.includes(sentinels.qrPayload)).toBe(false);
    }
    expect(captured.lines.join('\n').includes(sentinels.qrPayload)).toBe(false);
  });
});

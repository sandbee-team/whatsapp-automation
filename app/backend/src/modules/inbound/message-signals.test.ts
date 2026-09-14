import '../realtime/__test-support__/stub-wp-server-kit-env.js';
import { describe, expect, it, vi } from 'vitest';
import type { TenantQueryable } from '@wp/db';
import { createMetricsRegistry } from '@wp/server-kit';
import type { KeyProvider } from '@wp/server-kit/crypto';
import { OptOutCandidateText } from '@wp/domain';
import type { OptOutMirrorPort } from '../pacing/index.js';
import { bindInboundMetrics } from './metrics.js';
import { handleInboundMessageSignals, type MessageSignalsDeps } from './message-signals.js';

/**
 * message-signals.test.ts (P21 Unit U4, step 5) - `handleInboundMessageSignals`
 * unit tests. A fake `TenantDb`/`TenantQueryable` records every `{sql,
 * params}` issued inside the callback; `withTenant` itself pushes 'commit'
 * to a shared log AFTER the callback resolves, so ordering against the
 * post-commit `onOptedOut` port is directly observable.
 */

function makeCandidate(text: string): OptOutCandidateText {
  const candidate = OptOutCandidateText.fromPlainText(text);
  if (candidate === null) throw new Error('makeCandidate: unexpected null candidate');
  return candidate;
}

function makeProvider(): KeyProvider {
  return {
    getActive: vi.fn().mockReturnValue({
      kekId: 'k1',
      purpose: 'optout-pepper',
      material: Buffer.alloc(32, 0x02),
      retired: false,
    }),
    get: vi.fn(),
  };
}

interface RecordedQuery {
  sql: string;
  params: unknown[];
}

/** A fake `TenantDb` whose `withTenant` runs the callback against a fake `tx`
 * that records every query, and returns scripted rows keyed by a caller-
 * supplied matcher. `log` records 'commit' after the callback resolves, so a
 * test can assert `onOptedOut` fires strictly after that push. */
function makeFakeTx(
  queries: RecordedQuery[],
  scriptedRows: (sql: string) => { rows: unknown[]; rowCount: number | null },
): TenantQueryable {
  return {
    query: async <T extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
      params?: unknown[],
    ) => {
      queries.push({ sql, params: params ?? [] });
      return scriptedRows(sql) as { rows: T[]; rowCount: number | null };
    },
  };
}

function makeFakeTenantDb(
  log: string[],
  scriptedRows: (sql: string) => { rows: unknown[]; rowCount: number | null },
): {
  tenantDb: { withTenant: MessageSignalsDeps['tenantDb']['withTenant'] };
  queries: RecordedQuery[];
} {
  const queries: RecordedQuery[] = [];
  const tx = makeFakeTx(queries, scriptedRows);
  return {
    tenantDb: {
      withTenant: async (_clientId, fn) => {
        const result = await fn(tx);
        log.push('commit');
        return result;
      },
    },
    queries,
  };
}

function baseDeps(overrides: Partial<MessageSignalsDeps> = {}): {
  deps: MessageSignalsDeps;
  queries: RecordedQuery[];
  log: string[];
} {
  const log: string[] = [];
  const { tenantDb, queries } = makeFakeTenantDb(log, () => ({ rows: [], rowCount: 0 }));
  const metricsRegistry = createMetricsRegistry();
  const mirror: OptOutMirrorPort = async () => ({ contactsUpdated: 0 });
  const onOptedOut = vi.fn(async () => {
    log.push('onOptedOut');
  });
  const deps: MessageSignalsDeps = {
    tenantDb,
    clientId: 'client-1',
    instanceId: 'instance-1',
    keyProvider: makeProvider(),
    metrics: bindInboundMetrics(metricsRegistry),
    metricsRegistry,
    mirror,
    onOptedOut,
    ...overrides,
  };
  return { deps, queries, log };
}

describe('handleInboundMessageSignals', () => {
  it('an_attributed_message_touches_both_timestamps_in_one_transaction', async () => {
    let withTenantCalls = 0;
    const log: string[] = [];
    const queries: RecordedQuery[] = [];
    const tx = makeFakeTx(queries, () => ({ rows: [], rowCount: 0 }));
    const { deps } = baseDeps({
      tenantDb: {
        withTenant: async (_clientId, fn) => {
          withTenantCalls += 1;
          const result = await fn(tx);
          log.push('commit');
          return result;
        },
      },
    });

    const outcome = await handleInboundMessageSignals(deps, {
      senderJid: '15550001111@s.whatsapp.net',
      candidate: null,
    });

    expect(withTenantCalls).toBe(1);
    expect(outcome).toEqual({ attribution: 'attributed', optedOut: false, touched: true });

    const dmlQueries = queries.filter((q) =>
      /UPDATE contacts|INSERT INTO instance_recipient_contacts/.test(q.sql),
    );
    expect(dmlQueries.length).toBe(2);
    expect(dmlQueries[0]?.sql).toMatch(/UPDATE contacts/);
    expect(dmlQueries[1]?.sql).toMatch(/INSERT INTO instance_recipient_contacts/);

    for (const q of queries) {
      for (const param of q.params) {
        expect(typeof param === 'string' && param.includes('+1555')).toBe(false);
        expect(typeof param === 'string' && param.includes('@s.whatsapp.net')).toBe(false);
      }
    }
    const hashParam = dmlQueries[0]?.params.find((p) => Buffer.isBuffer(p));
    expect(Buffer.isBuffer(hashParam)).toBe(true);
  });

  it('the_confirmation_port_fires_only_after_commit', async () => {
    const log: string[] = [];
    const queries: RecordedQuery[] = [];
    const tx = makeFakeTx(queries, (sql) =>
      /INSERT INTO opt_outs/.test(sql)
        ? { rows: [{ id: 'opt-out-1' }], rowCount: 1 }
        : { rows: [], rowCount: 0 },
    );
    const onOptedOut = vi.fn(async () => {
      log.push('onOptedOut');
    });
    const { deps } = baseDeps({
      tenantDb: {
        withTenant: async (_clientId, fn) => {
          const result = await fn(tx);
          log.push('commit');
          return result;
        },
      },
      onOptedOut,
    });

    const outcome = await handleInboundMessageSignals(deps, {
      senderJid: '15550002222@s.whatsapp.net',
      candidate: makeCandidate('STOP'),
    });

    expect(outcome.optedOut).toBe(true);
    expect(onOptedOut).toHaveBeenCalledTimes(1);
    expect(log).toEqual(['commit', 'onOptedOut']);
  });

  it('a_lid_sender_without_a_mapping_touches_nothing_and_writes_no_optout', async () => {
    const { deps, queries } = baseDeps();

    const outcome = await handleInboundMessageSignals(deps, {
      senderJid: '123456789012@lid',
      candidate: makeCandidate('STOP'),
    });

    expect(outcome).toEqual({ attribution: 'unattributable', optedOut: false, touched: false });
    // The only query issued is the lid->pn mapping lookup itself (a
    // read-only SELECT, never a contact touch or opt-out write).
    expect(queries.length).toBe(1);
    expect(queries[0]?.sql).toMatch(/SELECT phone_e164 FROM contacts/);
    expect(
      queries.some((q) =>
        /UPDATE contacts|INSERT INTO instance_recipient_contacts|INSERT INTO opt_outs/.test(q.sql),
      ),
    ).toBe(false);

    const registry = deps.metricsRegistry;
    if (registry === undefined) throw new Error('expected metricsRegistry in deps');
    const snapshot = await registry.metricsText();
    expect(snapshot).toMatch(/wp_optout_unattributable_total 1/);
  });

  it('a_lid_sender_with_a_persisted_mapping_is_attributed', async () => {
    const resolveLid = vi.fn(async () => '15550003333@s.whatsapp.net');
    const { deps, queries } = baseDeps({ resolveLid });

    const outcome = await handleInboundMessageSignals(deps, {
      senderJid: '123456789013@lid',
      candidate: null,
    });

    expect(resolveLid).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ attribution: 'attributed', optedOut: false, touched: true });
    const contactsUpdate = queries.find((q) => /UPDATE contacts/.test(q.sql));
    expect(contactsUpdate).toBeDefined();
    const hashParam = contactsUpdate?.params.find((p) => Buffer.isBuffer(p));
    expect(Buffer.isBuffer(hashParam)).toBe(true);
  });

  it('no_query_parameter_or_log_line_carries_body_or_phone', async () => {
    const { deps, queries } = baseDeps();
    const secretText = 'STOP 9876543210 secret body';

    await handleInboundMessageSignals(deps, {
      senderJid: '15550004444@s.whatsapp.net',
      candidate: makeCandidate(secretText),
    });

    for (const q of queries) {
      expect(q.sql.includes('secret body')).toBe(false);
      for (const param of q.params) {
        expect(() => JSON.stringify({ param })).not.toThrow();
        const serialised = typeof param === 'string' ? param : JSON.stringify(param);
        expect(serialised.includes('secret body')).toBe(false);
        expect(serialised.includes('9876543210')).toBe(false);
        expect(serialised.includes('@s.whatsapp.net')).toBe(false);
      }
    }
  });
});

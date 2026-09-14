import '../../realtime/__test-support__/stub-wp-server-kit-env.js';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { TenantQueryable } from '@wp/db';
import {
  bindOptOutConfirmationSender,
  OPT_OUT_CONFIRMATION,
  sendOptOutConfirmation,
  SYSTEM_REPLY,
  type SendOptOutConfirmationDeps,
} from './system-send.js';

/**
 * system-send.test.ts (P14 Unit U4, step 5) - unit test over a stubbed
 * `tx`/`tenantDb`: proves the 30-day guard SQL shape is honoured (a second
 * call within the window enqueues nothing; a "day-31" call, simulated by
 * the guard UPDATE's own WHERE never matching in this stub's first branch,
 * enqueues) and that the enqueued job's `send_origin` is the exempt
 * `opt_out_confirmation` literal. The REAL 30-day behaviour (driven by an
 * actual `last_sent_at` row, real Postgres) is proved in
 * `registry.integration.test.ts`'s
 * `duplicate_stop_sends_one_confirmation_within_thirty_days`.
 */

function stubDeps(options: { guardReturnsRow: boolean }): {
  deps: SendOptOutConfirmationDeps;
  calls: { sql: string; params: unknown[] }[];
} {
  const calls: { sql: string; params: unknown[] }[] = [];
  const tx: TenantQueryable = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.includes('INSERT INTO optout_confirmations')) {
        return {
          rows: options.guardReturnsRow ? [{ '?column?': 1 }] : [],
          rowCount: options.guardReturnsRow ? 1 : 0,
        };
      }
      if (sql.includes('INSERT INTO message_jobs')) {
        return {
          rows: [
            {
              id: 'job-1',
              created_at: new Date('2026-09-02T00:00:00.000Z'),
              public_id: params[11],
              request_hash: null,
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    }) as TenantQueryable['query'],
  };
  const deps: SendOptOutConfirmationDeps = {
    tenantDb: { withTenant: async (_clientId, fn) => fn(tx) },
  };
  return { deps, calls };
}

describe('sendOptOutConfirmation (P14 Unit U4)', () => {
  it('SYSTEM_REPLY_and_OPT_OUT_CONFIRMATION_are_the_domain_exempt_literals', () => {
    expect(SYSTEM_REPLY).toBe('system_reply');
    expect(OPT_OUT_CONFIRMATION).toBe('opt_out_confirmation');
  });

  it('skips_enqueueing_when_the_thirty_day_guard_returns_no_row', async () => {
    const { deps, calls } = stubDeps({ guardReturnsRow: false });

    const result = await sendOptOutConfirmation(deps, {
      clientId: randomUUID(),
      instanceId: randomUUID(),
      phoneHash: Buffer.from('phone-hash-fixture'),
      e164: '+15550001111',
    });

    expect(result).toEqual({ enqueued: false });
    expect(calls.some((c) => c.sql.includes('INSERT INTO message_jobs'))).toBe(false);
  });

  it('enqueues_a_send_origin_opt_out_confirmation_job_when_the_guard_returns_a_row', async () => {
    const { deps, calls } = stubDeps({ guardReturnsRow: true });

    const result = await sendOptOutConfirmation(deps, {
      clientId: randomUUID(),
      instanceId: randomUUID(),
      phoneHash: Buffer.from('phone-hash-fixture'),
      e164: '+15550001111',
    });

    expect(result).toEqual({ enqueued: true });
    const jobInsert = calls.find((c) => c.sql.includes('INSERT INTO message_jobs'));
    expect(jobInsert).toBeDefined();
    // Bind order: client_id, instance_id, recipient_jid, recipient_e164,
    // recipient_hash, send_origin, ... (messages.repo.ts's INSERT param
    // order) - index 5 is send_origin.
    expect(jobInsert?.params[5]).toBe('opt_out_confirmation');

    const eventInsert = calls.find((c) => c.sql.includes('INSERT INTO pacing_events'));
    expect(eventInsert).toBeDefined();
  });
});

describe('bindOptOutConfirmationSender (P14 fix round F3 finding 4)', () => {
  it('a_rejected_send_logs_ids_and_error_class_only_never_the_e164', async () => {
    const clientId = randomUUID();
    const instanceId = randomUUID();
    const e164 = '+15550001111';
    const tx: TenantQueryable = {
      query: vi.fn(async () => {
        throw new Error(`constraint violation on ${e164}`);
      }) as TenantQueryable['query'],
    };
    const deps: SendOptOutConfirmationDeps = {
      tenantDb: { withTenant: async (_clientId, fn) => fn(tx) },
    };
    const errorLog = vi.fn();
    const send = bindOptOutConfirmationSender(deps, { error: errorLog });

    send({ clientId, instanceId, phoneHash: Buffer.from('phone-hash-fixture'), e164 });
    // sendOptOutConfirmation is async - flush its rejection's microtasks.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(errorLog).toHaveBeenCalledTimes(1);
    const [msg, meta] = errorLog.mock.calls[0] as [string, Record<string, unknown>];
    expect(msg).toMatch(/sendOptOutConfirmation/i);
    expect(meta).toEqual({ client_id: clientId, instance_id: instanceId, error_class: 'Error' });
    expect(JSON.stringify([msg, meta])).not.toContain(e164);
  });
});

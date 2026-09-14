import '../realtime/__test-support__/stub-wp-server-kit-env.js';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { TenantQueryable } from '@wp/db';
import type { KeyProvider } from '@wp/server-kit/crypto';
import { createMessageInputSchema } from '@wp/contracts';
import {
  createMessage,
  RecipientOptedOutError,
  type CreateMessageServiceInput,
} from './messages.service.js';

/**
 * enqueue.test.ts (P14 Unit U4, step 1; P24 Unit U4a stub update) -
 * mandatory test 23 (`send_origin_cannot_be_supplied_by_a_client`) plus the
 * service/repo wiring for the enqueue-time opt-out gate: `createMessage`
 * throws `RecipientOptedOutError` (no job row written) when `isOptedOut`
 * resolves true for a non-group recipient, skips the check entirely for a
 * `@g.us` recipient (running `resolveGroupForEnqueue`'s own SQL read
 * instead - `stubTx`'s `FROM wa_groups` branch answers a sendable,
 * send-enabled group row so this file's group test still proves the
 * opt-out SKIP, never the group-eligibility rejection path itself, which
 * `modules/groups/send.integration.test.ts` owns), and the repo INSERT is
 * given a typed `sendOrigin` parameter - never one read from client input
 * (contract-level proof lives in `packages/contracts/src/messages.test.ts`,
 * same test name).
 */

function makeKeyProvider(): KeyProvider {
  return {
    getActive: vi.fn().mockReturnValue({
      kekId: 'k-optout',
      purpose: 'optout-pepper',
      material: Buffer.alloc(32, 0x05),
      retired: false,
    }),
    get: vi.fn(),
  };
}

function baseInput(overrides: Partial<CreateMessageServiceInput> = {}): CreateMessageServiceInput {
  return {
    clientId: randomUUID(),
    instanceId: randomUUID(),
    idempotencyKey: 'idem-1',
    requestBody: {},
    recipient: { jid: '15550001111@s.whatsapp.net', e164: '+15550001111' },
    payload: { text: 'hi' },
    payloadKind: 'text',
    priority: 'normal',
    scheduledAt: null,
    sendOrigin: 'api_send',
    ...overrides,
  };
}

/** A minimal `TenantQueryable` stub whose `query` inspects the SQL text to answer the three statements `createMessage`/`enqueueMessageJob` run (link-status read, opt-out lookup, the job/ref insert CTE). */
function stubTx(options: { optedOut: boolean; linkState?: string; healthState?: string }): {
  tx: TenantQueryable;
  insertedParams: unknown[][];
} {
  const insertedParams: unknown[][] = [];
  const tx: TenantQueryable = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('FROM whatsapp_instances')) {
        return {
          rows: [
            {
              link_state: options.linkState ?? 'linked',
              health_state: options.healthState ?? 'connected',
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes('FROM opt_outs')) {
        return {
          rows: options.optedOut ? [{ '?column?': 1 }] : [],
          rowCount: options.optedOut ? 1 : 0,
        };
      }
      if (sql.includes('FROM wa_groups')) {
        // P24 Unit U4a: `resolveGroupForEnqueue`'s `group-send-lookup.sql`
        // read - a sendable, send-enabled group row (this file's group test
        // asserts the enqueue proceeds, never a rejection).
        return {
          rows: [
            {
              id: 'group-1',
              send_enabled: true,
              is_announce: false,
              our_role: 'member',
              tracked_participant_devices: 20,
              left_at: null,
              eff_group_daily_cap: 10,
              enabled_devices_total: '20',
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes('message_jobs.status')) {
        return { rows: [{ count: '0' }], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO message_jobs')) {
        insertedParams.push(params);
        // publicId is bound at index 11 (0-based) - $12 in the statement's
        // 1-based numbering (messages.repo.ts's INSERT param order) -
        // echoing it back as the returned public_id keeps `created: true`
        // (the CTE's own conflict branch never fires in this stub).
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
  return { tx, insertedParams };
}

function fakeTenantDb(tx: TenantQueryable): {
  withTenant: (clientId: string, fn: (tx: TenantQueryable) => Promise<unknown>) => Promise<unknown>;
} {
  return {
    withTenant: async (_clientId: string, fn: (tx: TenantQueryable) => Promise<unknown>) => fn(tx),
  };
}

describe('createMessage opt-out gate + send_origin threading (P14 Unit U4)', () => {
  it('throws_RecipientOptedOutError_and_writes_no_job_row_for_an_opted_out_contact', async () => {
    const { tx, insertedParams } = stubTx({ optedOut: true });
    const tenantDb = fakeTenantDb(tx);
    const keyProvider = makeKeyProvider();

    await expect(
      createMessage(tenantDb as never, baseInput(), { keyProvider }),
    ).rejects.toBeInstanceOf(RecipientOptedOutError);

    expect(insertedParams).toHaveLength(0);
  });

  it('skips_the_opt_out_check_entirely_for_a_group_recipient', async () => {
    const { tx, insertedParams } = stubTx({ optedOut: true });
    const tenantDb = fakeTenantDb(tx);
    const keyProvider = makeKeyProvider();

    const result = await createMessage(
      tenantDb as never,
      baseInput({ recipient: { jid: '123456-group@g.us', e164: null } }),
      { keyProvider },
    );

    expect(result.status).toBe('queued');
    expect(insertedParams).toHaveLength(1);
  });

  it('writes_the_typed_sendOrigin_parameter_onto_the_insert_never_from_client_input', async () => {
    const { tx, insertedParams } = stubTx({ optedOut: false });
    const tenantDb = fakeTenantDb(tx);
    const keyProvider = makeKeyProvider();

    await createMessage(tenantDb as never, baseInput({ sendOrigin: 'api_send' }), { keyProvider });

    expect(insertedParams).toHaveLength(1);
    // Bind order: client_id, instance_id, recipient_jid, recipient_e164,
    // recipient_hash, send_origin, payload, payload_kind, priority,
    // priority_rank, scheduled_at, public_id, idempotency_key, request_hash
    // (messages.repo.ts's INSERT statement, verbatim param order).
    expect(insertedParams[0]?.[5]).toBe('api_send');
  });

  it('send_origin_cannot_be_supplied_by_a_client', () => {
    // Mandatory test 23, service-layer half: the contract schema (the FIRST
    // line of defence, proved exhaustively in packages/contracts/src/
    // messages.test.ts) never lets an origin/sendOrigin field survive
    // parsing, so it can never reach this service's input at all - re-proved
    // here at the boundary this unit owns, over the SAME schema import.
    const parsed = createMessageInputSchema.safeParse({
      kind: 'text',
      recipient: '+15550001111',
      payload: { text: 'hi' },
      priority: 'normal',
      sendOrigin: 'system_reply',
    });
    expect(parsed.success).toBe(false);
  });
});

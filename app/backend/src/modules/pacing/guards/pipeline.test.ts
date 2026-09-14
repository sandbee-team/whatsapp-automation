import '../../realtime/__test-support__/stub-wp-server-kit-env.js';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { TenantQueryable } from '@wp/db';
import { evaluateGuards, type EvaluateGuardsInput } from './pipeline.js';

/**
 * pipeline.test.ts (P14 Unit U6, phase step 7) - unit test over a stubbed
 * `tx`: proves the ORDER (opt-out -> blocked words -> link guard ->
 * duplicate fan-out -> recipient frequency, first denial wins, later
 * guards never run) and the terminal-vs-defer resolution
 * (`DENY_REASON_EFFECTS`-derived `jobOutcome`) without a real Postgres
 * connection. Real end-to-end proof (real guard SQL, real deny reasons)
 * lives in `pipeline.integration.test.ts`.
 */

function baseState(): EvaluateGuardsInput['state'] {
  return {
    warmupTier: 4,
    localDate: '2026-09-02',
    dupFanoutWarn: 150,
    dupFanoutAck: 500,
    perRecipient24h: 30,
    perRecipient7d: 60,
  };
}

function baseJob(overrides: Partial<EvaluateGuardsInput['job']> = {}): EvaluateGuardsInput['job'] {
  return {
    id: randomUUID(),
    recipientJid: '15550001111@s.whatsapp.net',
    recipientHash: Buffer.from('pipeline-fixture-hash'),
    sendOrigin: 'api_send',
    contentFingerprint: null,
    payload: { text: 'Hello there, thanks for your order!' },
    payloadKind: 'text',
    isNewConversation: false,
    ...overrides,
  };
}

/** A `tx` stub that answers every guard's own query shape with a "never trips" row - only the ONE targeted table is made to trip, so the test proves ordering/short-circuit, not guard internals (those are proved by each guard's own suite). */
function stubTxNeverTripping(): { tx: TenantQueryable; queries: string[] } {
  const queries: string[] = [];
  const tx: TenantQueryable = {
    query: vi.fn(async (sql: string) => {
      queries.push(sql);
      if (sql.includes('FROM opt_outs')) return { rows: [], rowCount: 0 };
      if (sql.includes('FROM tenant_blocked_words')) return { rows: [], rowCount: 0 };
      if (sql.includes('FROM instance_recipient_contacts')) return { rows: [], rowCount: 0 };
      if (sql.includes('content_fingerprint_recipients')) {
        return { rows: [{ recipient_count: 1, ack_at: null }], rowCount: 1 };
      }
      if (sql.includes('FROM recipient_send_buckets')) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    }) as TenantQueryable['query'],
  };
  return { tx, queries };
}

describe('evaluateGuards (P14 Unit U6)', () => {
  it('an_opted_out_recipient_denies_at_the_opt_out_gate_and_runs_no_later_guard', async () => {
    const { tx, queries } = stubTxNeverTripping();
    (tx.query as ReturnType<typeof vi.fn>).mockImplementation(async (sql: string) => {
      if (sql.includes('FROM opt_outs')) return { rows: [{ '?column?': 1 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });

    const result = await evaluateGuards(tx, {
      clientId: randomUUID(),
      instanceId: randomUUID(),
      job: baseJob(),
      state: baseState(),
      now: new Date('2026-09-02T10:00:00.000Z'),
    });

    expect(result).toEqual({
      ok: false,
      denial: {
        reason: 'OPT_OUT',
        retryAt: new Date('2026-09-02T10:00:00.000Z'),
        jobOutcome: 'cancelled',
      },
    });
    expect(queries.some((sql) => sql.includes('FROM tenant_blocked_words'))).toBe(false);
  });

  it('a_blocked_word_denies_as_failed_without_reaching_the_link_or_frequency_guards', async () => {
    const { tx, queries } = stubTxNeverTripping();
    (tx.query as ReturnType<typeof vi.fn>).mockImplementation(async (sql: string) => {
      if (sql.includes('FROM opt_outs')) return { rows: [], rowCount: 0 };
      if (sql.includes('FROM tenant_blocked_words')) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    });

    const result = await evaluateGuards(tx, {
      clientId: randomUUID(),
      instanceId: randomUUID(),
      job: baseJob({ payload: { text: 'Please send me the OTP right now' } }),
      state: baseState(),
      now: new Date('2026-09-02T10:00:00.000Z'),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.denial.reason).toBe('BLOCKED_WORD');
      expect(result.denial.jobOutcome).toBe('failed');
    }
    expect(queries.some((sql) => sql.includes('FROM instance_recipient_contacts'))).toBe(false);
    expect(queries.some((sql) => sql.includes('FROM recipient_send_buckets'))).toBe(false);
  });

  it('needs_human_ack_substitutes_the_bounded_recheck_hold_when_the_evaluator_has_no_retry_at', async () => {
    const { tx } = stubTxNeverTripping();
    (tx.query as ReturnType<typeof vi.fn>).mockImplementation(async (sql: string) => {
      if (sql.includes('content_fingerprint_recipients')) {
        return { rows: [{ recipient_count: 501, ack_at: null }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    const now = new Date('2026-09-02T10:00:00.000Z');
    const result = await evaluateGuards(tx, {
      clientId: randomUUID(),
      instanceId: randomUUID(),
      job: baseJob(),
      state: baseState(),
      now,
    });

    expect(result).toEqual({
      ok: false,
      denial: {
        reason: 'NEEDS_HUMAN_ACK',
        retryAt: new Date('2026-09-02T10:05:00.000Z'),
        jobOutcome: 'queued',
      },
    });
  });

  it('a_media_only_payload_with_no_text_body_skips_every_body_based_guard', async () => {
    const { tx, queries } = stubTxNeverTripping();

    const result = await evaluateGuards(tx, {
      clientId: randomUUID(),
      instanceId: randomUUID(),
      job: baseJob({ payload: {}, payloadKind: 'media' }),
      state: baseState(),
      now: new Date('2026-09-02T10:00:00.000Z'),
    });

    expect(result).toEqual({ ok: true });
    expect(queries.some((sql) => sql.includes('FROM tenant_blocked_words'))).toBe(false);
    expect(queries.some((sql) => sql.includes('FROM instance_recipient_contacts'))).toBe(false);
    expect(queries.some((sql) => sql.includes('content_fingerprint_recipients'))).toBe(false);
  });

  it('a_media_caption_is_a_body_and_faces_the_body_based_guards', async () => {
    // P34 (2026-09-14): a caption is tenant-written text that reaches the
    // recipient. If the body extractor read only `payload.text`, moving the
    // words into a caption would bypass blocked words, the link guard and
    // duplicate fan-out entirely - a guard hole with a one-line entry price.
    const { tx, queries } = stubTxNeverTripping();

    const result = await evaluateGuards(tx, {
      clientId: randomUUID(),
      instanceId: randomUUID(),
      job: baseJob({
        payload: { mediaId: randomUUID(), caption: 'Please send me the OTP right now' },
        payloadKind: 'media',
      }),
      state: baseState(),
      now: new Date('2026-09-02T10:00:00.000Z'),
    });

    // The caption carries the SAME text the blocked-word case above uses, and
    // it is denied identically - proof the guard reads the caption, not just
    // `payload.text`. Before this fix the same job resolved `{ ok: true }`.
    expect(result.ok).toBe(false);
    expect(queries.some((sql) => sql.includes('FROM tenant_blocked_words'))).toBe(true);
  });

  it('every_guard_passing_resolves_ok', async () => {
    const { tx } = stubTxNeverTripping();

    const result = await evaluateGuards(tx, {
      clientId: randomUUID(),
      instanceId: randomUUID(),
      job: baseJob(),
      state: baseState(),
      now: new Date('2026-09-02T10:00:00.000Z'),
    });

    expect(result).toEqual({ ok: true });
  });
});

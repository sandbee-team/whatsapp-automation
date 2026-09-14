import '../realtime/__test-support__/stub-wp-server-kit-env.js';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { TenantQueryable } from '@wp/db';
import { notifyEmpty, notifyLowIfDue } from './state-notifier.js';

/**
 * state-notifier.test.ts (P19 Unit U4, step 6) - unit-level: a fake `tx`
 * whose `query` stands in for both `wallet-state-warned.sql` (gate/stamp)
 * and `notify-fanout.sql` (notify()'s own statement), driven purely by call
 * order (this module always calls its own gate/stamp statement FIRST, then
 * `notify()`'s statement second - see state-notifier.ts's own call sequence).
 * Fake clock throughout (`nowMs` injected) - no wall-clock read anywhere.
 */

interface FakeCall {
  text: string;
  params: unknown[];
}

function outboxRows(channels: readonly string[], notificationId: string, clientId: string) {
  return channels.map((channel) => ({
    id: notificationId,
    client_id: clientId,
    entity_id: notificationId,
    fanout: [channel],
  }));
}

describe('notifyLowIfDue', () => {
  it('a_low_balance_warns_once_per_24_hours', async () => {
    const clientId = randomUUID();
    const calls: FakeCall[] = [];
    let gateFires = true;

    const tx: TenantQueryable = {
      query: vi.fn(async (text: string, params: unknown[] = []) => {
        calls.push({ text, params });
        if (text.includes('last_low_warning_at = now()')) {
          return gateFires
            ? { rows: [{ last_low_warning_at: '2026-09-04T00:00:00.000Z' }] }
            : { rows: [] };
        }
        // notify-fanout.sql
        return { rows: outboxRows(['sse', 'email', 'webhook'], randomUUID(), clientId) };
      }) as unknown as TenantQueryable['query'],
    };

    const first = await notifyLowIfDue(
      tx,
      { nowMs: Date.parse('2026-09-04T00:00:00.000Z') },
      clientId,
    );
    expect(first).toBe(true);

    // Second crossing within the same 24h window - the gate statement
    // itself now matches zero rows (simulated via gateFires=false), so
    // notify() must never even be attempted.
    gateFires = false;
    calls.length = 0;
    const second = await notifyLowIfDue(
      tx,
      { nowMs: Date.parse('2026-09-04T12:00:00.000Z') },
      clientId,
    );
    expect(second).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toContain('last_low_warning_at = now()');

    // After 24h, the gate fires again and a fresh warning is sent.
    gateFires = true;
    calls.length = 0;
    const third = await notifyLowIfDue(
      tx,
      { nowMs: Date.parse('2026-09-05T01:00:00.000Z') },
      clientId,
    );
    expect(third).toBe(true);
    expect(calls).toHaveLength(2);
  });
});

describe('notifyEmpty', () => {
  it('entering_empty_notifies_in_app_email_and_webhook_exactly_once', async () => {
    const clientId = randomUUID();
    const lastEmptyAt = '2026-09-04T03:15:00.000Z';
    const notificationId = randomUUID();
    let notifyCallCount = 0;

    const tx: TenantQueryable = {
      query: vi.fn(async (text: string) => {
        if (text.includes('last_empty_at = now()')) {
          return { rows: [{ last_empty_at: lastEmptyAt }] };
        }
        // notify-fanout.sql - simulate a 50-send drain storm calling this
        // repeatedly with the SAME transitionId (lastEmptyAt unchanged):
        // only the FIRST call creates a row, every later one dedupes.
        notifyCallCount += 1;
        if (notifyCallCount === 1) {
          return { rows: outboxRows(['sse', 'email', 'webhook'], notificationId, clientId) };
        }
        return { rows: [] };
      }) as unknown as TenantQueryable['query'],
    };

    const results = await Promise.all(
      Array.from({ length: 50 }, () => notifyEmpty(tx, clientId, 12)),
    );

    const createdCount = results.filter((created) => created).length;
    expect(createdCount).toBe(1);
  });

  it('no_wallet_row_means_nothing_is_stamped_or_notified', async () => {
    const tx: TenantQueryable = {
      query: vi.fn(async () => ({ rows: [] })) as unknown as TenantQueryable['query'],
    };

    const created = await notifyEmpty(tx, randomUUID(), 3);
    expect(created).toBe(false);
  });
});

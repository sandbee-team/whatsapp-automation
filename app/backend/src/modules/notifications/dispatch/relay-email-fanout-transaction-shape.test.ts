import '../../realtime/__test-support__/stub-wp-server-kit-env.js';
import { describe, expect, it, vi } from 'vitest';
import type { RelayPool, RelayPoolClient, ClaimedEmailRow } from '../../events/index.js';
import type { Mailer } from '../../../platform/mailer.js';
import { createRelayEmailFanoutPort } from './relay-email-fanout.js';

/**
 * relay-email-fanout-transaction-shape.test.ts (P17 fix round F1, reviewer-
 * prescribed regression; moved beside its subject from `roles/` at P17 close,
 * see relay-email-fanout.ts's own header) - a fake-pool, no-DB, no-Redis unit
 * test that exercises the REAL PRODUCTION WIRING (`createRelayEmailFanoutPort`
 * itself, not a stubbed `EmailFanoutPort` and not a bare pool passed straight
 * to `dispatch/email.ts`'s own port) - this is precisely the gap that let the
 * first F1 attempt's bug survive: every other test either stubbed the whole
 * port (`relay-loop-email-crash.test.ts`) or called `createEmailDispatchPort`
 * directly with a bare `pool` that has no BEGIN/COMMIT tracking at all
 * (`dispatch/email*.integration.test.ts`). This file is the ONE place that
 * proves the actual transaction boundary: NO `sendNotificationEmail` call
 * happens between the fake connection's `BEGIN` and `COMMIT`.
 */

function makeFakeRedis(): { incr: () => Promise<number>; expire: () => Promise<number> } {
  return {
    incr: async () => 1,
    expire: async () => 1,
  };
}

interface RecordedEvent {
  kind: 'sql' | 'sendMail';
  detail: string;
}

/** A fake `RelayPool`/`RelayPoolClient` that answers the two `resolve()` reads with one real recipient (so `send()` actually attempts a mailer call - otherwise the timing assertion below would be vacuously true) and records every SQL statement + release call into the SAME `events` log a recording `Mailer` also writes into. */
function makeFakePool(events: RecordedEvent[]): RelayPool {
  const client: RelayPoolClient = {
    async query<T extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
    ): Promise<{ rows: T[]; rowCount: number | null }> {
      events.push({ kind: 'sql', detail: sql.trim().split('\n')[0] ?? sql });
      if (sql.includes('wp_notification_email_recipients')) {
        return {
          rows: [{ user_id: 'user-1', email: 'owner@example.com' } as unknown as T],
          rowCount: 1,
        };
      }
      if (sql.includes('wp_notification_instance_label')) {
        return { rows: [{ label: 'Test Instance' } as unknown as T], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => {
      events.push({ kind: 'sql', detail: 'RELEASE' });
    },
  };

  return { connect: async () => client };
}

function makeRecordingMailer(events: RecordedEvent[]): Mailer {
  return {
    async sendVerificationEmail(): Promise<void> {},
    async sendLockoutEmail(): Promise<void> {},
    async sendReuseDetectedEmail(): Promise<void> {},
    async sendPasswordResetEmail(): Promise<void> {},
    async sendNotificationEmail(): Promise<void> {
      events.push({ kind: 'sendMail', detail: 'sendNotificationEmail' });
    },
  };
}

const CLIENT_ID = '11111111-1111-4111-8111-111111111111';
const INSTANCE_ID = '22222222-2222-4222-8222-222222222222';

function makeRow(): ClaimedEmailRow {
  return {
    id: 'outbox-row-1',
    clientId: CLIENT_ID,
    instanceId: INSTANCE_ID,
    kind: 'instance_paused',
    payload: {},
  };
}

describe('createRelayEmailFanoutPort transaction shape (P17 fix round F1 regression)', () => {
  it('no_sendMail_call_occurs_between_BEGIN_and_COMMIT_on_the_real_production_wiring', async () => {
    const events: RecordedEvent[] = [];
    const pool = makeFakePool(events);
    const mailer = makeRecordingMailer(events);
    // The REAL createRelayEmailFanoutPort - not a stub, not a bare pool
    // handed to dispatch/email.ts directly.
    const port = createRelayEmailFanoutPort(
      makeFakeRedis() as unknown as Parameters<typeof createRelayEmailFanoutPort>[0],
      'test',
      mailer,
    );

    await port.dispatchEmails(pool, [makeRow()]);

    const beginIndex = events.findIndex((e) => e.detail === 'BEGIN');
    const commitIndex = events.findIndex((e) => e.detail === 'COMMIT');
    const sendMailIndex = events.findIndex((e) => e.kind === 'sendMail');

    expect(beginIndex).toBeGreaterThanOrEqual(0);
    expect(commitIndex).toBeGreaterThan(beginIndex);
    expect(sendMailIndex).toBeGreaterThanOrEqual(0);
    // The actual regression assertion: sendMail happens strictly AFTER
    // COMMIT, never between BEGIN and COMMIT.
    expect(sendMailIndex).toBeGreaterThan(commitIndex);
  });

  it('the_connection_is_released_before_sendMail_ever_runs', async () => {
    const events: RecordedEvent[] = [];
    const pool = makeFakePool(events);
    const mailer = makeRecordingMailer(events);
    const port = createRelayEmailFanoutPort(
      makeFakeRedis() as unknown as Parameters<typeof createRelayEmailFanoutPort>[0],
      'test',
      mailer,
    );

    await port.dispatchEmails(pool, [makeRow()]);

    const releaseIndex = events.findIndex((e) => e.detail === 'RELEASE');
    const sendMailIndex = events.findIndex((e) => e.kind === 'sendMail');

    expect(releaseIndex).toBeGreaterThanOrEqual(0);
    expect(sendMailIndex).toBeGreaterThan(releaseIndex);
  });

  it('zero_rows_never_opens_a_connection_at_all', async () => {
    const events: RecordedEvent[] = [];
    const pool = makeFakePool(events);
    const connectSpy = vi.spyOn(pool, 'connect');
    const mailer = makeRecordingMailer(events);
    const port = createRelayEmailFanoutPort(
      makeFakeRedis() as unknown as Parameters<typeof createRelayEmailFanoutPort>[0],
      'test',
      mailer,
    );

    await port.dispatchEmails(pool, []);

    expect(connectSpy).not.toHaveBeenCalled();
  });
});

import { describe, expect, it, vi } from 'vitest';
import { createCredsSaveBuffer, CREDS_SAVE_BUFFER_MAX } from './creds-save-buffer.js';
import { isPgUnavailableError } from './pg-unavailable.js';

/**
 * creds-save-buffer.test.ts (P26 U6a) - pure unit tests over
 * `createCredsSaveBuffer` with a fake `saveCreds`/`schedule`/`now`. No real
 * Postgres/Redis here (see `postgres-outage.integration.test.ts` for the
 * real-infra proof at worker-composition level).
 */

class FenceConflictErrorStub extends Error {
  constructor() {
    super('fence conflict');
    this.name = 'FenceConflictError';
  }
}

function pgUnavailableError(): Error & { code: string } {
  const err = new Error('terminating connection due to administrator command') as Error & {
    code: string;
  };
  err.code = '57P01';
  return err;
}

function makeSchedule() {
  const pending: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  const schedule = vi.fn((fn: () => void, ms: number) => {
    const entry = { fn, ms, cancelled: false };
    pending.push(entry);
    return {
      cancel: () => {
        entry.cancelled = true;
      },
    };
  });
  return {
    schedule,
    pendingCount: () => pending.filter((e) => !e.cancelled).length,
    fireLatest: () => {
      const entry = [...pending].reverse().find((e) => !e.cancelled);
      if (!entry) throw new Error('fireLatest: no pending, non-cancelled timer');
      entry.fn();
    },
  };
}

describe('createCredsSaveBuffer', () => {
  it('healthy passthrough calls saveCreds directly, buffers nothing, and resolves the store credVersion', async () => {
    const saveCreds = vi.fn().mockResolvedValue({ credVersion: 1n });
    const { schedule } = makeSchedule();
    const buffer = createCredsSaveBuffer({
      saveCreds,
      isPgUnavailable: isPgUnavailableError,
      now: () => 0,
      schedule,
      readExpectedVersion: () => 0n,
    });

    const result = await buffer.save({ creds: { a: 1 }, expectedVersion: 0n, fence: 1n });

    expect(saveCreds).toHaveBeenCalledTimes(1);
    expect(saveCreds).toHaveBeenCalledWith({ creds: { a: 1 }, expectedVersion: 0n, fence: 1n });
    expect(result).toEqual({ credVersion: 1n });
    expect(buffer.size()).toBe(0);
    expect(buffer.dropped()).toBe(0);
    expect(buffer.unavailable()).toBe(false);
  });

  it('a non-PG-unavailable error on a live save rethrows and is not buffered', async () => {
    const saveCreds = vi.fn().mockRejectedValue(new FenceConflictErrorStub());
    const { schedule } = makeSchedule();
    const buffer = createCredsSaveBuffer({
      saveCreds,
      isPgUnavailable: isPgUnavailableError,
      now: () => 0,
      schedule,
      readExpectedVersion: () => 0n,
    });

    await expect(buffer.save({ creds: {}, expectedVersion: 0n, fence: 1n })).rejects.toThrow(
      'fence conflict',
    );
    expect(buffer.size()).toBe(0);
    expect(buffer.unavailable()).toBe(false);
  });

  it('20 saves during an outage keep only the newest 8 (13..20), dropping 12, with one pending timer', async () => {
    const saveCreds = vi.fn().mockRejectedValue(pgUnavailableError());
    const { schedule, pendingCount } = makeSchedule();
    const events: string[] = [];
    const buffer = createCredsSaveBuffer({
      saveCreds,
      isPgUnavailable: isPgUnavailableError,
      now: () => 0,
      schedule,
      onEvent: (e) => events.push(e.kind),
      readExpectedVersion: () => 0n,
    });

    for (let i = 1; i <= 20; i += 1) {
      await buffer.save({ creds: { wpDrillSeq: i }, expectedVersion: 0n, fence: 1n });
    }

    expect(buffer.size()).toBe(CREDS_SAVE_BUFFER_MAX);
    expect(buffer.size()).toBe(8);
    expect(buffer.dropped()).toBe(12);
    expect(buffer.unavailable()).toBe(true);
    expect(pendingCount()).toBe(1);
    expect(events.filter((k) => k === 'buffered').length).toBe(8);
    expect(events.filter((k) => k === 'dropped').length).toBe(12);

    // saveCreds was attempted exactly once (the first save) before the
    // buffer flips unavailable - every subsequent save() goes straight to
    // the buffer without hitting PG again.
    expect(saveCreds).toHaveBeenCalledTimes(1);
  });

  it('flush applies exactly the newest buffered entry and clears the whole buffer', async () => {
    let resolvedWith: unknown;
    const saveCreds = vi
      .fn()
      .mockRejectedValueOnce(pgUnavailableError())
      .mockImplementationOnce((args: unknown) => {
        resolvedWith = args;
        return Promise.resolve({ credVersion: 1n });
      });
    const { schedule } = makeSchedule();
    const buffer = createCredsSaveBuffer({
      saveCreds,
      isPgUnavailable: isPgUnavailableError,
      now: () => 0,
      schedule,
      readExpectedVersion: () => 0n,
    });

    await buffer.save({ creds: { seq: 1 }, expectedVersion: 0n, fence: 1n });
    await buffer.save({ creds: { seq: 2 }, expectedVersion: 0n, fence: 1n });
    expect(buffer.size()).toBe(2);

    const result = await buffer.flush();

    expect(result).toEqual({ applied: true, remaining: 0, credVersion: 1n });
    expect(buffer.size()).toBe(0);
    expect(buffer.unavailable()).toBe(false);
    expect(resolvedWith).toEqual({ creds: { seq: 2 }, expectedVersion: 0n, fence: 1n });
  });

  it('flush that hits PG-unavailable keeps the buffer and reschedules', async () => {
    const saveCreds = vi.fn().mockRejectedValue(pgUnavailableError());
    const { schedule, pendingCount } = makeSchedule();
    const events: string[] = [];
    const buffer = createCredsSaveBuffer({
      saveCreds,
      isPgUnavailable: isPgUnavailableError,
      now: () => 0,
      schedule,
      onEvent: (e) => events.push(e.kind),
      readExpectedVersion: () => 0n,
    });

    await buffer.save({ creds: { seq: 1 }, expectedVersion: 0n, fence: 1n });
    expect(pendingCount()).toBe(1);

    const result = await buffer.flush();

    expect(result).toEqual({ applied: false, remaining: 1 });
    expect(buffer.size()).toBe(1);
    expect(buffer.unavailable()).toBe(true);
    expect(events).toContain('flush_failed_pg_unavailable');
    expect(pendingCount()).toBe(1);
  });

  it('a fence error on flush rethrows and does not re-buffer (clears nothing, unavailable() false)', async () => {
    const saveCreds = vi
      .fn()
      .mockRejectedValueOnce(pgUnavailableError())
      .mockRejectedValueOnce(new FenceConflictErrorStub());
    const { schedule } = makeSchedule();
    const buffer = createCredsSaveBuffer({
      saveCreds,
      isPgUnavailable: isPgUnavailableError,
      now: () => 0,
      schedule,
      readExpectedVersion: () => 0n,
    });

    await buffer.save({ creds: { seq: 1 }, expectedVersion: 0n, fence: 1n });
    expect(buffer.size()).toBe(1);

    await expect(buffer.flush()).rejects.toThrow('fence conflict');

    // "clear nothing" - the buffered entry is still there (forensic only).
    expect(buffer.size()).toBe(1);
    expect(buffer.unavailable()).toBe(false);
  });

  it('the retry timer callback triggers a flush that applies the buffered save', async () => {
    let call = 0;
    const saveCreds = vi.fn().mockImplementation(() => {
      call += 1;
      if (call === 1) return Promise.reject(pgUnavailableError());
      return Promise.resolve({ credVersion: 1n });
    });
    const { schedule, fireLatest } = makeSchedule();
    const buffer = createCredsSaveBuffer({
      saveCreds,
      isPgUnavailable: isPgUnavailableError,
      now: () => 0,
      schedule,
      readExpectedVersion: () => 0n,
    });

    await buffer.save({ creds: { seq: 1 }, expectedVersion: 0n, fence: 1n });
    expect(buffer.size()).toBe(1);

    fireLatest();
    // flush() runs fire-and-forget from inside the timer callback - flush
    // the microtask queue before asserting.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(buffer.size()).toBe(0);
    expect(buffer.unavailable()).toBe(false);
  });

  it('a rejecting flush from the timer reaches onError and never escapes as an unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (err: unknown) => unhandled.push(err);
    process.on('unhandledRejection', onUnhandledRejection);
    try {
      let call = 0;
      const saveCreds = vi.fn().mockImplementation(() => {
        call += 1;
        if (call === 1) return Promise.reject(pgUnavailableError());
        return Promise.reject(new FenceConflictErrorStub());
      });
      const { schedule, fireLatest } = makeSchedule();
      const onError = vi.fn();
      const buffer = createCredsSaveBuffer({
        saveCreds,
        isPgUnavailable: isPgUnavailableError,
        now: () => 0,
        schedule,
        onError,
        readExpectedVersion: () => 0n,
      });

      await buffer.save({ creds: { seq: 1 }, expectedVersion: 0n, fence: 1n });
      expect(buffer.size()).toBe(1);

      fireLatest();
      // The scheduled flush() rejects (fence conflict) - onError must catch
      // it, never let it surface as an unhandled rejection.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(onError).toHaveBeenCalledTimes(1);
      expect((onError.mock.calls[0]?.[0] as Error).message).toBe('fence conflict');
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  });

  it('dispose() cancels the pending timer only, without flushing or clearing', async () => {
    const saveCreds = vi.fn().mockRejectedValue(pgUnavailableError());
    const { schedule, pendingCount } = makeSchedule();
    const buffer = createCredsSaveBuffer({
      saveCreds,
      isPgUnavailable: isPgUnavailableError,
      now: () => 0,
      schedule,
      readExpectedVersion: () => 0n,
    });

    await buffer.save({ creds: { seq: 1 }, expectedVersion: 0n, fence: 1n });
    expect(pendingCount()).toBe(1);

    buffer.dispose();

    expect(pendingCount()).toBe(0);
    expect(buffer.size()).toBe(1);
    // saveCreds was only ever called for the original failed live attempt.
    expect(saveCreds).toHaveBeenCalledTimes(1);
  });
});

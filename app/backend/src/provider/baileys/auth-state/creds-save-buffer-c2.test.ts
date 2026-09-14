import { describe, expect, it, vi } from 'vitest';
import { createCredsSaveBuffer } from './creds-save-buffer.js';
import { isPgUnavailableError } from './pg-unavailable.js';

/**
 * creds-save-buffer-c2.test.ts (P26 C2) - max-lines split off
 * `creds-save-buffer.test.ts` (established idiom - `session-worker-
 * discovery-wiring.ts`): edge-case coverage for the dangling-retry-timer
 * boundary, the exact 7/8/9 buffer-size transition, and a straggling save()
 * arriving after teardown has already disposed the buffer.
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
  };
}

describe('createCredsSaveBuffer - C2 edge cases', () => {
  it('a buffered (PG-unavailable) save resolves undefined - nothing was persisted to advance to (FIX-P26-G)', async () => {
    const saveCreds = vi.fn().mockRejectedValue(pgUnavailableError());
    const { schedule } = makeSchedule();
    const buffer = createCredsSaveBuffer({
      saveCreds,
      isPgUnavailable: isPgUnavailableError,
      now: () => 0,
      schedule,
      readExpectedVersion: () => 0n,
    });

    const result = await buffer.save({ creds: { a: 1 }, expectedVersion: 0n, fence: 1n });

    expect(result).toBeUndefined();
    expect(buffer.size()).toBe(1);
  });

  it('a fence error on a DIRECT flush() call does not cancel an already-armed retry timer (dispose() still cancels it)', async () => {
    // Coverage gap (C2): flush() throwing a non-PG error clears unavailable()
    // but never touches `pendingTimer` itself - only the CALLER's dispose()
    // stops it from firing again later. This proves the module's own
    // documented contract ("clears nothing" refers to the buffer, not the
    // timer) so a caller that forgets to dispose() is the only way this can
    // leak, never the buffer silently self-healing.
    const saveCreds = vi
      .fn()
      .mockRejectedValueOnce(pgUnavailableError())
      .mockRejectedValueOnce(new FenceConflictErrorStub());
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

    await expect(buffer.flush()).rejects.toThrow('fence conflict');

    // The retry timer armed by the original PG-unavailable save is STILL
    // pending - flush()'s own fence-error path never cancels it.
    expect(pendingCount()).toBe(1);
    expect(buffer.unavailable()).toBe(false);

    buffer.dispose();
    expect(pendingCount()).toBe(0);
  });

  it('20 saves during an outage keep exactly 8 at the boundary transition (7 buffered, then the 8th, then the 9th drops the 1st)', async () => {
    // Exact-value boundary test (never a bound): size at 7, 8, then 9 saves.
    const saveCreds = vi.fn().mockRejectedValue(pgUnavailableError());
    const { schedule } = makeSchedule();
    const events: { kind: string; seq?: number }[] = [];
    const buffer = createCredsSaveBuffer({
      saveCreds,
      isPgUnavailable: isPgUnavailableError,
      now: () => 0,
      schedule,
      onEvent: (e) => events.push({ kind: e.kind, seq: e.seq }),
      readExpectedVersion: () => 0n,
    });

    for (let i = 1; i <= 7; i += 1) {
      await buffer.save({ creds: { seq: i }, expectedVersion: 0n, fence: 1n });
    }
    expect(buffer.size()).toBe(7);
    expect(buffer.dropped()).toBe(0);

    await buffer.save({ creds: { seq: 8 }, expectedVersion: 0n, fence: 1n });
    expect(buffer.size()).toBe(8);
    expect(buffer.dropped()).toBe(0);

    await buffer.save({ creds: { seq: 9 }, expectedVersion: 0n, fence: 1n });
    expect(buffer.size()).toBe(8);
    expect(buffer.dropped()).toBe(1);
    // Newest-wins: the 9th save's own entry (seq 9) triggers the 'dropped'
    // event (it is what pushed the buffer over capacity); the OLDEST entry
    // (seq 1) is the one actually evicted from the buffer by buffer.shift().
    expect(events.at(-1)).toEqual({ kind: 'dropped', seq: 9 });
  });

  it('a save() that arrives AFTER teardown has disposed the buffer still resolves (buffered), never throwing into the caller', async () => {
    // "a save resolving AFTER teardown began" (C2 scenario): dispose() only
    // cancels the retry timer - it does not close save()'s own contract, so
    // a straggling creds.update firing after teardown's dispose() must still
    // be a safe no-throw buffer-or-passthrough, never an unhandled path.
    const saveCreds = vi.fn().mockRejectedValue(pgUnavailableError());
    const { schedule } = makeSchedule();
    const buffer = createCredsSaveBuffer({
      saveCreds,
      isPgUnavailable: isPgUnavailableError,
      now: () => 0,
      schedule,
      readExpectedVersion: () => 0n,
    });

    await buffer.save({ creds: { seq: 1 }, expectedVersion: 0n, fence: 1n });
    buffer.dispose();

    await expect(
      buffer.save({ creds: { seq: 2 }, expectedVersion: 0n, fence: 1n }),
    ).resolves.toBeUndefined();
    expect(buffer.size()).toBe(2);
  });

  it('FIX-P26-G: flush() resolves the version AT FLUSH TIME (not the stale value snapshotted at enqueue time) and reports it via onFlushed', async () => {
    let resolvedWith: unknown;
    const saveCreds = vi
      .fn()
      .mockRejectedValueOnce(pgUnavailableError())
      .mockImplementationOnce((args: unknown) => {
        resolvedWith = args;
        return Promise.resolve({ credVersion: 3n });
      });
    const { schedule } = makeSchedule();
    // The version advanced (0n -> 3n) WHILE the entry sat buffered - proves
    // flush() reads `readExpectedVersion()` live rather than replaying the
    // `expectedVersion: 0n` snapshotted into the buffered entry at enqueue time.
    let liveVersion = 0n;
    const onFlushed = vi.fn();
    const buffer = createCredsSaveBuffer({
      saveCreds,
      isPgUnavailable: isPgUnavailableError,
      now: () => 0,
      schedule,
      readExpectedVersion: () => liveVersion,
      onFlushed,
    });

    await buffer.save({ creds: { seq: 1 }, expectedVersion: 0n, fence: 1n });
    await buffer.save({ creds: { seq: 2 }, expectedVersion: 0n, fence: 1n });
    expect(buffer.size()).toBe(2);
    liveVersion = 3n;

    const result = await buffer.flush();

    expect(result).toEqual({ applied: true, remaining: 0, credVersion: 3n });
    expect(resolvedWith).toEqual({ creds: { seq: 2 }, expectedVersion: 3n, fence: 1n });
    expect(onFlushed).toHaveBeenCalledTimes(1);
    expect(onFlushed).toHaveBeenCalledWith(3n);
  });
});

import { vi } from 'vitest';
import { createPool } from '@wp/db';
import { seedLease, seedTenant } from '../../modules/instances/__tests__/instances-test-helpers.js';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';

/**
 * runner-test-fixtures.ts (P08 U5a, split from runner-test-support.ts to
 * stay under max-lines) - the fake-socket/fake-clock/fake-scheduler/seed
 * primitives shared by every runner test file. `buildRunner` itself (the
 * bigger composition helper) stays in runner-test-support.ts.
 */

export const pool = createPool({
  connectionString: resolveDatabaseUrl(),
  applicationName: 'runner-test',
});
export const probeClientIds: string[] = [];

export interface FakeSock {
  ev: {
    on(ev: string, cb: (u: unknown) => void): void;
    /**
     * Test-only: fires `ev` and returns whatever the wrapped callback
     * returns. The real `FakeableSocket.ev.on` contract is fire-and-forget
     * (`cb: (u: any) => void`, matching Baileys' own EventEmitter) - the
     * runner's real callback is `void onConnectionUpdate(...)` internally.
     * This helper captures that inner promise so the test can `await` real
     * Postgres I/O deterministically instead of guessing a microtask-queue
     * depth with bare `Promise.resolve()` calls.
     */
    emit(ev: string, payload: unknown): Promise<void>;
  };
  end: ReturnType<typeof vi.fn<(err?: Error) => void>>;
  user?: { id: string };
}

export function makeFakeSock(): FakeSock {
  const handlers = new Map<string, (u: unknown) => unknown>();
  return {
    ev: {
      on(ev: string, cb: (u: unknown) => void) {
        handlers.set(ev, cb);
      },
      async emit(ev: string, payload: unknown) {
        // Bounded microtask-only poll (never a real timer/sleep) for the
        // handler to appear before giving up: `runner.ts`'s `start()`
        // registers `connection.update` from inside a fire-and-forget
        // deferred chain (connect-gate wait -> grace wait -> offset wait ->
        // `buildAndWireSocket()`) whenever ANY of those legs applies - even
        // a fully-resolved fake `connectGate.take()` still costs one extra
        // microtask hop per awaited leg versus the old synchronous-looking
        // `await runner.start(...)` callers assumed. 200 iterations of a
        // bare microtask yield is plenty (each leg is at most a handful of
        // hops) and adds zero real wall-clock cost when the handler is
        // already there (the common, non-deferred case exits on iteration
        // 0). A genuinely missing handler (a real test bug) still throws
        // after the bound - this is a poll, not a wait-forever.
        let cb = handlers.get(ev);
        for (let i = 0; i < 200 && !cb; i += 1) {
          await Promise.resolve();
          cb = handlers.get(ev);
        }
        if (!cb) {
          throw new Error(`emit: no handler registered for "${ev}"`);
        }
        await cb(payload);
      },
    },
    end: vi.fn(),
  };
}

export function makeClock(startMs: number) {
  let current = startMs;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

export interface FakeTimerScheduler {
  setTimeoutFn: (fn: () => void, ms: number) => number;
  clearTimeoutFn: (id: number) => void;
  fireAll(): Promise<void>;
  pendingCount(): number;
}

export function makeFakeTimerScheduler(): FakeTimerScheduler {
  const pending = new Map<number, { fn: () => void; ms: number }>();
  let nextId = 1;
  return {
    setTimeoutFn: (fn: () => void, ms: number) => {
      const id = nextId;
      nextId += 1;
      pending.set(id, { fn, ms });
      return id;
    },
    clearTimeoutFn: (id: number) => {
      pending.delete(id);
    },
    fireAll: async () => {
      const entries = [...pending.entries()];
      pending.clear();
      for (const [, entry] of entries) {
        entry.fn();
        await Promise.resolve();
      }
    },
    pendingCount: () => pending.size,
  };
}

export async function seedProbe(overrides: { healthState?: string; linkState?: string } = {}) {
  const { clientId, instanceId } = await seedTenant(pool, {
    healthState: overrides.healthState ?? 'never_linked',
    linkState: overrides.linkState ?? 'unlinked',
  });
  probeClientIds.push(clientId);
  const fence = 1n;
  await seedLease(pool, { clientId, instanceId, fence, workerId: 'worker-runner-test' });
  // A7: null pairing_started_at now means EXPIRED, not fail-open - a plain
  // UPDATE (not beginPairingIntent, which would also force link_state).
  const query =
    'UPDATE whatsapp_instances SET pairing_started_at = now() WHERE id = $1 AND client_id = $2';
  await pool.query(query, [instanceId, clientId]);
  return { clientId, instanceId, fence };
}

export interface PublishedEvent {
  type: string;
  [key: string]: unknown;
}

export type PublishMock = ReturnType<typeof vi.fn<(event: PublishedEvent) => void>>;

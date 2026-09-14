import { randomUUID } from 'node:crypto';

/**
 * send-load-driver.ts (P26 U2b, step 2) - the Node load-driver half of the
 * multi-tenant send-load harness (`scripts/loadtest/tenant-mix.json` is the
 * SAME mix file `send-load.k6.mjs`, the k6 script, reads - see that file's own
 * header for why no code can be shared across the JS/k6 boundary). This
 * module produced this session's load-test artifacts because there is no k6
 * binary on the measurement host; `send-load.k6.mjs` ships as specified but is
 * NOT executed here.
 *
 * `runSendLoad` is the PURE driver loop: every timing input (`now`, `sleep`,
 * `rng`) is injected, so the unit test runs it against a fake clock with
 * zero real waiting (same idiom as `scripts/measure/ramp-sessions.ts`'s
 * `readRssBytes?`). It drives one shared virtual timeline across every plan
 * item plus the optional burst, always advancing to the single NEXT event
 * (never polling), so a caller with a real `setTimeout`-backed `sleep` gets
 * real pacing and a fake-clock test gets instant, deterministic execution.
 *
 * The isMain-guarded RUNNABLE wiring (which seeds real rows, drives this
 * loop with a real clock, and writes the artifact) lives in the sibling
 * `send-load-driver-run.ts` (max-lines discipline - the split idiom
 * `session-worker-discovery-wiring.ts` established) - see that file's own
 * header for WHICH enqueue path it wires and why.
 */

export interface EnqueueJobInput {
  clientId: string;
  instanceId: string;
  recipientJid: string;
  text: string;
  idempotencyKey: string;
}

export interface SendLoadDriverDeps {
  enqueue: (job: EnqueueJobInput) => Promise<void>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  onTick?: (t: { atMs: number; enqueued: number; errors: number; inflight: number }) => void;
}

export interface SendLoadPlanItem {
  clientId: string;
  instanceId: string;
  intervalMs: number;
  tenantKey: string;
}

export interface SendLoadBurstOptions {
  atMs: number;
  clientId: string;
  instanceId: string;
  recipients: number;
  tenantKey?: string;
}

export interface SendLoadOptions {
  durationMs: number;
  jitterRatio?: number;
  rng: () => number;
  burst?: SendLoadBurstOptions;
}

export interface SendLoadResult {
  enqueued: number;
  errors: number;
  perTenant: Record<string, number>;
  burstEnqueued: number;
  startedAtMs: number;
  endedAtMs: number;
}

interface ScheduledItem {
  item: SendLoadPlanItem;
  nextAtMs: number;
}

/** Jittered next-fire delay: `intervalMs * (1 + jitterRatio * (rng()*2 - 1))`, floored at 1ms. `rng()===0.5` yields zero jitter (the term is exactly 0), which is what the unit test relies on for exact counts. */
function nextDelayMs(intervalMs: number, jitterRatio: number, rng: () => number): number {
  const jitter = jitterRatio * (rng() * 2 - 1);
  return Math.max(1, Math.round(intervalMs * (1 + jitter)));
}

/** Enqueues one job for `item`, counting the result into `result` - an enqueue rejection increments `errors` and is otherwise swallowed (a load driver that dies on one error measures nothing). */
async function enqueueOne(
  deps: SendLoadDriverDeps,
  result: SendLoadResult,
  clientId: string,
  instanceId: string,
  tenantKey: string,
  isBurst: boolean,
): Promise<void> {
  try {
    await deps.enqueue({
      clientId,
      instanceId,
      recipientJid: `${randomUUID().replaceAll('-', '')}@s.whatsapp.net`,
      // Distinct per job (templated-but-unique, like real tenant traffic) -
      // identical text to every recipient would be the duplicate-fan-out
      // shape the content guards exist to catch, not a load model.
      text: `load-test ${tenantKey} ${result.enqueued + result.burstEnqueued + 1} ${randomUUID().slice(0, 8)}`,
      idempotencyKey: randomUUID(),
    });
    result.enqueued += 1;
    if (isBurst) {
      result.burstEnqueued += 1;
    } else {
      result.perTenant[tenantKey] = (result.perTenant[tenantKey] ?? 0) + 1;
    }
  } catch {
    result.errors += 1;
  }
}

/**
 * Drives `plan` over `opts.durationMs` on ONE shared virtual timeline: each
 * plan item enqueues one job every `intervalMs` (jittered via the injected
 * `rng`, never `Math.random`); the optional `burst` enqueues `recipients`
 * jobs for its own instance as fast as the enqueue port accepts them,
 * starting at `atMs`, WITHOUT pausing the steady stream (the burst's jobs
 * are dispatched concurrently with whichever steady sends land in the same
 * virtual-time window). The loop advances to the single next event each
 * iteration (never polls), so a real `sleep` produces real pacing and a
 * fake-clock test executes instantly.
 */
export async function runSendLoad(
  plan: readonly SendLoadPlanItem[],
  deps: SendLoadDriverDeps,
  opts: SendLoadOptions,
): Promise<SendLoadResult> {
  const jitterRatio = opts.jitterRatio ?? 0;
  const startedAtMs = deps.now();
  const result: SendLoadResult = {
    enqueued: 0,
    errors: 0,
    perTenant: {},
    burstEnqueued: 0,
    startedAtMs,
    endedAtMs: startedAtMs,
  };

  const scheduled: ScheduledItem[] = plan.map((item) => ({
    item,
    nextAtMs: startedAtMs + nextDelayMs(item.intervalMs, jitterRatio, opts.rng),
  }));
  let burstFired = false;
  let inflight = 0;

  let clockMs = startedAtMs;
  const endAtMs = startedAtMs + opts.durationMs;

  while (clockMs < endAtMs) {
    let nextEventMs = endAtMs;
    for (const scheduledItem of scheduled) {
      if (scheduledItem.nextAtMs < nextEventMs) nextEventMs = scheduledItem.nextAtMs;
    }
    if (opts.burst && !burstFired && opts.burst.atMs < nextEventMs) {
      nextEventMs = opts.burst.atMs;
    }
    nextEventMs = Math.min(nextEventMs, endAtMs);

    if (nextEventMs > clockMs) {
      await deps.sleep(nextEventMs - clockMs);
    }
    clockMs = nextEventMs;

    if (opts.burst && !burstFired && clockMs >= opts.burst.atMs) {
      burstFired = true;
      const burst = opts.burst;
      inflight += burst.recipients;
      const burstPromises: Promise<void>[] = [];
      for (let i = 0; i < burst.recipients; i += 1) {
        burstPromises.push(
          enqueueOne(
            deps,
            result,
            burst.clientId,
            burst.instanceId,
            burst.tenantKey ?? 'burst',
            true,
          ),
        );
      }
      await Promise.all(burstPromises);
      inflight -= burst.recipients;
    }

    for (const scheduledItem of scheduled) {
      if (scheduledItem.nextAtMs === clockMs) {
        inflight += 1;
        await enqueueOne(
          deps,
          result,
          scheduledItem.item.clientId,
          scheduledItem.item.instanceId,
          scheduledItem.item.tenantKey,
          false,
        );
        inflight -= 1;
        scheduledItem.nextAtMs =
          clockMs + nextDelayMs(scheduledItem.item.intervalMs, jitterRatio, opts.rng);
      }
    }

    deps.onTick?.({ atMs: clockMs, enqueued: result.enqueued, errors: result.errors, inflight });
  }

  result.endedAtMs = clockMs;
  return result;
}

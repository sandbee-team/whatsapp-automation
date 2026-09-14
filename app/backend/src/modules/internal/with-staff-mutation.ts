import type { FastifyRequest } from 'fastify';
import type { StaffAction } from '@wp/domain';
import { assertStaffCan, resolveStaffActor, type StaffActor } from './actor.js';
import type { AdminAppPool, AdminAppQueryable } from './staff-audit.js';
import { readReplay, IdempotencyKeyReusedError } from './idempotency.js';
import {
  bindStaffMetrics,
  type StaffMetricsHandles,
} from '../../platform/metrics/staff-metrics.js';

/**
 * with-staff-mutation.ts (P28 Unit U3a, step 4) - `withStaffMutation`, the
 * ONLY entry point for a staff write. See the phase dispatch for the full
 * binding order rationale; this header restates it as the module's own
 * contract so a future editor never has to re-derive it.
 *
 * BINDING ORDER, one pinned connection: `BEGIN` -> `SET LOCAL ROLE wp_app`
 * -> tenant GUC -> resolve actor + RBAC -> INSERT `staff_audit_log` (the
 * FIRST write; a unique-violation on `staff_audit_log_idempotency_key_key`
 * rolls back and replays, everything else rethrows) -> run `fn` -> UPDATE
 * `staff_audit_log.result` -> `COMMIT`. The audit-row/mutation atomicity
 * guarantee is UNCONDITIONAL: fail any step, roll back everything after the
 * INSERT too.
 */

export interface StaffMutationTx {
  query: AdminAppQueryable['query'];
  auditId: string;
  actor: StaffActor;
  /** Runs `fn` under `wp_admin_app` for the one statement class that needs it (the `topup_requests` status UPDATE), then restores `wp_app`. */
  asAdminRole: <T>(fn: (db: AdminAppQueryable) => Promise<T>) => Promise<T>;
  /** Registers `cb` to run strictly AFTER `COMMIT` - a failure there is logged/counted, never a 5xx. */
  afterCommit: (cb: () => void | Promise<void>) => void;
}

export interface WithStaffMutationInput {
  action: StaffAction;
  clientId: string | null;
  targetKind: string | null;
  targetRef: string | null;
  reason: string;
  requestHash: string;
}

export interface AuditWriteOverride {
  insert: (
    db: AdminAppQueryable,
    input: WithStaffMutationInput & { staffId: string; idempotencyKey: string },
  ) => Promise<string>;
  update: (db: AdminAppQueryable, auditId: string, result: unknown) => Promise<void>;
}

export interface WithStaffMutationDeps {
  pool: AdminAppPool;
  auditWrite?: AuditWriteOverride;
  metrics?: StaffMetricsHandles;
}

export interface WithStaffMutationResult<T> {
  data: T;
  replayed: boolean;
  auditId: string;
}

function serializeResult(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? v.toString() : v)));
}

function isIdempotencyKeyViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === '23505' &&
    (err as { constraint?: unknown }).constraint === 'staff_audit_log_idempotency_key_key'
  );
}

async function defaultInsertAudit(
  db: AdminAppQueryable,
  input: WithStaffMutationInput & { staffId: string; idempotencyKey: string },
): Promise<string> {
  const result = await db.query<{ id: string }>(
    `INSERT INTO staff_audit_log
       (staff_id, action, client_id, target_kind, target_ref, reason, idempotency_key, request_hash, result)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, '{}')
     RETURNING id`,
    [
      input.staffId,
      input.action,
      input.clientId,
      input.targetKind,
      input.targetRef,
      input.reason,
      input.idempotencyKey,
      input.requestHash,
    ],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error('withStaffMutation: staff_audit_log INSERT returned no row');
  }
  return row.id;
}

async function defaultUpdateAudit(
  db: AdminAppQueryable,
  auditId: string,
  result: unknown,
): Promise<void> {
  await db.query(`UPDATE staff_audit_log SET result = $2 WHERE id = $1`, [
    auditId,
    JSON.stringify(result),
  ]);
}

/**
 * Runs a fresh short transaction to look up the replayed result for
 * `idempotencyKey` - the ORIGINAL insert's transaction has already rolled
 * back (nothing of it persisted except via the other, winning transaction).
 * Runs under `wp_admin_app` (BYPASSRLS), never `wp_app` - the winning row may
 * belong to a DIFFERENT client than `clientId` (idempotency key reused across
 * clients), and `readReplay` itself is what decides reuse-vs-replay from the
 * row's own `client_id`/`request_hash`; see `idempotency.ts`'s header.
 */
async function replayAfterConflict(
  pool: AdminAppPool,
  clientId: string | null,
  idempotencyKey: string,
  requestHash: string,
  log: { error: (obj: Record<string, unknown>, msg: string) => void },
): Promise<{ auditId: string; result: unknown }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      await client.query('SET LOCAL ROLE wp_admin_app');
      const replay = await readReplay(client, idempotencyKey, clientId, requestHash);
      await client.query('COMMIT');
      return { auditId: replay.auditId, result: replay.result };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (!(err instanceof IdempotencyKeyReusedError)) {
        // Unreachable in the normal 23505-then-replay path: the INSERT that
        // triggered this lookup proves a row exists. Reaching here means the
        // row vanished between the violation and this SELECT - a defect, not
        // a client-facing condition - so it is logged distinctly and still
        // surfaces as a 500 via the generic error mapper.
        log.error({ idempotencyKey, clientId, err, defect: true }, 'replayAfterConflict: defect');
      }
      throw err;
    }
  } finally {
    client.release();
  }
}

/** The ONLY entry point for a staff write - see module header for the full binding-order contract. */
export async function withStaffMutation<T>(
  deps: WithStaffMutationDeps,
  req: FastifyRequest,
  input: WithStaffMutationInput,
  fn: (tx: StaffMutationTx) => Promise<T>,
): Promise<WithStaffMutationResult<T>> {
  const idempotencyKeyHeader = req.headers['idempotency-key'];
  const actorHeader = req.headers['x-actor'];
  if (typeof idempotencyKeyHeader !== 'string' || typeof actorHeader !== 'string') {
    throw new Error(
      'withStaffMutation: missing idempotency-key/x-actor header (validate at the route boundary first)',
    );
  }

  const insertAudit = deps.auditWrite?.insert ?? defaultInsertAudit;
  const updateAudit = deps.auditWrite?.update ?? defaultUpdateAudit;
  const metrics = deps.metrics ?? bindStaffMetrics();

  const client = await deps.pool.connect();
  const afterCommitCallbacks: Array<() => void | Promise<void>> = [];
  let released = false;
  let releaseError: unknown;
  const release = (err?: unknown): void => {
    if (released) return;
    released = true;
    if (err !== undefined) {
      client.release(err as Error);
    } else {
      client.release();
    }
  };

  try {
    await client.query('BEGIN');
    try {
      await client.query('SET LOCAL ROLE wp_app');
      await client.query('SELECT set_config($1, $2, true)', [
        'app.client_id',
        input.clientId ?? '',
      ]);

      const actor = await resolveStaffActor(client, actorHeader);
      assertStaffCan(actor, input.action);

      let auditId: string;
      try {
        auditId = await insertAudit(client, {
          ...input,
          staffId: actor.staffId,
          idempotencyKey: idempotencyKeyHeader,
        });
      } catch (err) {
        if (isIdempotencyKeyViolation(err)) {
          // Guarded like `replayAfterConflict`'s own ROLLBACK (:137 as of the
          // C2 fix round 2): the INSERT already failed on 23505, so this
          // ROLLBACK is cleanup, not the primary error path - a driver-level
          // failure here must never mask the replay result below. Note: a
          // replay never calls `metrics.incStaffMutation` (:236) - only the
          // winning transaction that performs the INSERT+`fn` does.
          await client.query('ROLLBACK').catch(() => undefined);
          release();
          const replay = await replayAfterConflict(
            deps.pool,
            input.clientId,
            idempotencyKeyHeader,
            input.requestHash,
            req.log,
          );
          return { data: replay.result as T, replayed: true, auditId: replay.auditId };
        }
        throw err;
      }

      const asAdminRole = async <R>(adminFn: (db: AdminAppQueryable) => Promise<R>): Promise<R> => {
        await client.query('SET LOCAL ROLE wp_admin_app');
        try {
          return await adminFn(client);
        } finally {
          await client.query('SET LOCAL ROLE wp_app');
        }
      };

      const tx: StaffMutationTx = {
        query: client.query.bind(client),
        auditId,
        actor,
        asAdminRole,
        afterCommit: (cb) => {
          afterCommitCallbacks.push(cb);
        },
      };

      const data = await fn(tx);
      const serialized = serializeResult(data);
      await updateAudit(client, auditId, serialized);
      await client.query('COMMIT');

      metrics.incStaffMutation(input.action);

      for (const cb of afterCommitCallbacks) {
        try {
          await cb();
        } catch (err) {
          req.log.error(
            { action: input.action, auditId, err },
            'withStaffMutation: afterCommit callback failed',
          );
        }
      }

      return { data, replayed: false, auditId };
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        releaseError = rollbackErr;
      }
      throw err;
    }
  } finally {
    release(releaseError);
  }
}

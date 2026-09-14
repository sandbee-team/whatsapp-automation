import { REGISTERED_PLATFORM_READS } from './registered-reads.js';

/**
 * platform/platform-read.ts (P28 Unit U4, step 6) - the ONE audited entry
 * point for every cross-tenant read admin-backend performs, and the ONLY
 * file that may enter the `wp_admin_app` (BYPASSRLS) role
 * (`platform-read.test.ts` asserts both mechanically).
 *
 * BINDING GUARANTEE (pinned by
 * `platform-read.integration.test.ts#every_platform_read_writes_an_audit_row_in_the_same_transaction`):
 * the `audit_logs` row and the read itself share ONE transaction on ONE
 * pinned connection. So:
 *  - a read that returns data has ALWAYS left an audit row (they commit
 *    together);
 *  - a read that fails leaves NO audit row and returns no data (they roll
 *    back together) - staff cannot probe the platform and leave a clean
 *    trail by making the query fail;
 *  - an UNREGISTERED `query.key` throws `UnregisteredPlatformReadError`
 *    BEFORE `pool.connect()` is ever called, so an unreviewed read never
 *    even holds a connection.
 *
 * The audit row is written FIRST, before `fn` runs. That ordering is
 * deliberate: it means a read whose SQL is killed mid-flight (statement
 * timeout) still has its intent recorded in the same transaction that is
 * about to roll back - and, more importantly, that the INSERT's own failure
 * (e.g. a missing grant) aborts the read rather than producing unaudited
 * data.
 *
 * admin/backend NEVER writes anything but `audit_logs`, `staff_users`,
 * `staff_sessions` and `leads` (ADR 0014 fact 1/12); the `wp_admin_app` grant surface
 * enforces that at the database, so an accidental write inside `fn` fails
 * with Postgres `42501` rather than succeeding - see
 * `modules/clients/clients.read.integration.test.ts#
 * admin_backend_never_opens_a_write_connection_to_a_send_path_table`.
 */

/** Minimal query surface handed to a read function - deliberately NOT a `pg.PoolClient` (no `release`/transaction control reaches read code). */
export interface AdminReadQueryable {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;
}

export interface AdminReadPoolClient extends AdminReadQueryable {
  release(err?: unknown): void;
}

/** Same minimal `connect()` shape app-backend's `AdminAppPool` uses - never `pg`'s own `Pool` type. */
export interface AdminReadPool {
  connect(): Promise<AdminReadPoolClient>;
}

export interface PlatformReadDeps {
  pool: AdminReadPool;
  /** Structured defect logging for the `42501`/unexpected-write case; injected so tests can capture it. */
  logDefect?: (fields: Record<string, unknown>) => void;
  /** Counter hook - `wp_admin_platform_reads_total{route}`, injected by `server.ts`. */
  onRead?: (key: string) => void;
}

/** The acting staff member plus the request-scoped facts every audit row carries. */
export interface StaffCtx {
  staffId: string;
  requestId: string;
  /** `req.ip` - stored in `audit_logs.ip` (inet). */
  ip: string | null;
}

export interface PlatformReadQuery {
  /** Must be a member of `REGISTERED_PLATFORM_READS` - see module header. */
  key: string;
  /** The staff member's stated reason, carried into `audit_logs.metadata`. */
  reason: string;
  /** The tenant this read is ABOUT, when it is about one; `null`/absent = a genuinely platform-wide read. */
  clientId?: string | null;
  targetType?: string;
  targetId?: string;
}

export class UnregisteredPlatformReadError extends Error {
  readonly code = 'INTERNAL';
  constructor(key: string) {
    super(`platform-read: "${key}" is not a registered platform read.`);
    this.name = 'UnregisteredPlatformReadError';
  }
}

const PLATFORM_READ_ACTION = 'platform.read';

/**
 * The ONE role-change statement in admin-backend. `SET LOCAL` (not plain
 * `SET`) is mandatory: transaction pooling makes a session-scoped role
 * change leak across unrelated requests, and BYPASSRLS leaking is the worst
 * possible thing to leak. Declared once, used by both entry points below.
 */
const ENTER_ADMIN_ROLE = 'SET LOCAL ROLE wp_admin_app';

const INSERT_AUDIT_ROW = `INSERT INTO audit_logs
    (client_id, actor_type, actor_staff_id, action, target_type, target_id, metadata, ip, request_id)
  VALUES ($1, 'staff', $2, $3, $4, $5, $6::jsonb, $7, $8)`;

/**
 * Runs `fn` under `wp_admin_app` on one pinned connection, inside the same
 * transaction as its own `audit_logs` row. See the module header for the
 * exact guarantee this provides and why it is unbypassable.
 */
export async function platformRead<T>(
  deps: PlatformReadDeps,
  ctx: StaffCtx,
  query: PlatformReadQuery,
  fn: (db: AdminReadQueryable) => Promise<T>,
): Promise<T> {
  if (!REGISTERED_PLATFORM_READS.has(query.key)) {
    // BEFORE pool.connect() - an unreviewed read never holds a connection.
    throw new UnregisteredPlatformReadError(query.key);
  }
  deps.onRead?.(query.key);

  const client = await deps.pool.connect();
  let releaseError: unknown;
  try {
    await client.query('BEGIN');
    try {
      await client.query(ENTER_ADMIN_ROLE);
      await client.query(INSERT_AUDIT_ROW, [
        query.clientId ?? null,
        ctx.staffId,
        PLATFORM_READ_ACTION,
        query.targetType ?? null,
        query.targetId ?? null,
        JSON.stringify({ query: query.key, reason: query.reason }),
        ctx.ip,
        ctx.requestId,
      ]);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      // A write attempt from inside `fn` is a DEFECT, not a user error: the
      // grant surface caught something admin-backend must never do. Logged
      // with a stable marker so an alert can fire on it; the caller still
      // gets an INTERNAL error and zero rows, and the audit row rolls back.
      if (isInsufficientPrivilege(err)) {
        deps.logDefect?.({
          event: 'platform_read_write_attempt',
          severity: 'defect',
          read_key: query.key,
          request_id: ctx.requestId,
          pg_code: '42501',
        });
      }
      try {
        await client.query('ROLLBACK');
        releaseError = undefined;
      } catch (rollbackErr) {
        releaseError = rollbackErr;
      }
      throw err;
    }
  } finally {
    if (releaseError !== undefined) {
      client.release(releaseError as Error);
    } else {
      client.release();
    }
  }
}

/** Postgres `insufficient_privilege` - the grant surface refusing a write admin-backend must never attempt. */
function isInsufficientPrivilege(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === '42501';
}

/**
 * Runs `fn` on one pinned connection inside a transaction that has entered
 * `wp_admin_app`, WITHOUT writing a `platform.read` audit row - the
 * staff-auth path (`modules/staff-auth/sessions.ts`).
 *
 * It lives here, not in `staff-auth/`, because this file is the ONLY one
 * permitted to issue the role change at all (`platform-read.test.ts#
 * a_cross_tenant_read_outside_platform_read_is_impossible` proves that with
 * a source scan) - keeping the statement in one file is what makes the
 * "no unaudited cross-tenant read" claim mechanical rather than conventional.
 *
 * It is deliberately NOT `platformRead`: a login is not a read of tenant
 * data, and a FAILED login must still COMMIT its lockout-counter increment,
 * which is the exact opposite of `platformRead`'s roll-back-everything rule.
 * Its own audit events go through `writeStaffAuditEvent` below.
 */
export async function withStaffRoleTx<T>(
  pool: AdminReadPool,
  fn: (db: AdminReadQueryable) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      await client.query(ENTER_ADMIN_ROLE);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // The original error is what must propagate, not a rollback failure.
      }
      throw err;
    }
  } finally {
    client.release();
  }
}

/**
 * The staff-auth audit path (`staff.login.*`/`staff.logout`/
 * `staff.refresh.reuse_detected`). SEPARATE from `platformRead` on purpose:
 * a login attempt is not a read of tenant data (there is no `fn`, no
 * `clientId`, and - crucially - a FAILED login must still leave its audit
 * row, whereas a failed platform read must leave none). Best-effort by
 * design: an audit-write failure must never be the reason a staff member
 * cannot be told their password was wrong, so it is logged and swallowed
 * rather than surfaced.
 */
export async function writeStaffAuditEvent(
  deps: PlatformReadDeps,
  input: {
    action: string;
    staffId: string | null;
    requestId: string;
    ip: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  let client: AdminReadPoolClient;
  try {
    client = await deps.pool.connect();
  } catch (err) {
    deps.logDefect?.({
      event: 'staff_audit_write_failed',
      action: input.action,
      error: String(err),
    });
    return;
  }
  try {
    await client.query('BEGIN');
    await client.query(ENTER_ADMIN_ROLE);
    await client.query(INSERT_AUDIT_ROW, [
      null,
      input.staffId,
      input.action,
      'staff_user',
      input.staffId,
      JSON.stringify(input.metadata ?? {}),
      input.ip,
      input.requestId,
    ]);
    await client.query('COMMIT');
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // The audit write already failed; a rollback failure adds nothing.
    }
    deps.logDefect?.({
      event: 'staff_audit_write_failed',
      action: input.action,
      error: String(err),
    });
  } finally {
    client.release();
  }
}

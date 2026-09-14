import { randomUUID } from 'node:crypto';
import { createPool, createTenantDb } from '@wp/db';
import { resolveDatabaseUrl } from '../src/platform/db/db-url.js';
import {
  seedSendTenant,
  cleanupSendProbeClients,
} from '../src/engine/queue/__tests__/queue-send-tenant-fixture.js';
import { seedQueuedJob } from '../src/engine/queue/__tests__/queue-send-test-helpers.js';
import {
  buildInternalApp,
  cleanupStaffUsers,
  makeStaffHeaders,
  seedStaffUser,
} from '../src/modules/internal/__tests__/internal-routes-test-support.js';
import { attemptClaim } from '../src/modules/internal/__tests__/internal-mutations-support.js';
import {
  ledgerRows,
  walletAccount,
} from '../src/modules/internal/__tests__/internal-probe-support.js';
import {
  seedExtraInstance,
  jobStatusCounts,
} from '../src/modules/internal/__tests__/internal-u3b-support.js';
import { demoAuditRows, demoNotificationRows } from './p28-staff-demo-probes.js';

/**
 * app/backend/scripts/p28-staff-demo.ts (P28, step 10) - a ONE-SHOT evidence
 * script, not part of the shipped `src/` tree: it prints the P28 end-to-end
 * demo ("staff suspend a client + adjust a wallet") the phase's Definition
 * of Done asks for, running the SAME flow
 * `staff_suspend_stops_claiming_and_preserves_every_queued_job`
 * (`src/modules/internal/internal-mutations-clients.integration.test.ts`)
 * and `staff_wallet_adjustment_writes_one_ledger_row_and_one_audit_row`
 * (`src/modules/internal/internal-mutations.integration.test.ts`) exercise,
 * with its rows PRINTED instead of asserted. It imports those two tests'
 * own `__tests__/` fixtures directly (`buildInternalApp`, `seedSendTenant`,
 * the probe readers) - allowed here because `no-deep-module-import`'s glob
 * (`app/backend/src/modules/**`) does not reach `app/backend/scripts/**`,
 * and because a divergent hand-rolled seed would risk drifting from what the
 * real gate tests actually exercise. Never imported by shipped runtime code;
 * run manually via `pnpm exec tsx scripts/p28-staff-demo.ts` against
 * `wp_test2` (see `docs/evidence/P28-admin-grants-and-audit.md` section 5).
 *
 * Exit code: 0 only if, after the two mutations, all six seeded jobs are
 * still `queued`/untouched AND both `staff_audit_log` rows exist; 1
 * otherwise, with the mismatch printed. Every probe row this script creates
 * is deleted before exit (see the `finally` block), whichever way the
 * assertions came out.
 */

const SECRET = 'p28-staff-demo-service-token-secret-0123456789';

function shortId(id: string): string {
  return id.slice(0, 8);
}

function mdTable(headers: string[], rows: string[][]): string {
  const head = `| ${headers.join(' | ')} |`;
  const sep = `|${headers.map(() => '---').join('|')}|`;
  const body = rows.map((row) => `| ${row.join(' | ')} |`).join('\n');
  return [head, sep, body].join('\n');
}

async function main(): Promise<void> {
  const pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'p28-staff-demo',
  });
  const tenantDb = createTenantDb(pool);
  const probeClientIds: string[] = [];
  const probeStaffIds: string[] = [];
  const wakeCalls: Array<{ clientId: string; instanceId: string }> = [];
  let exitCode = 0;
  const lines: string[] = [];

  try {
    const app = await buildInternalApp({
      pool,
      tenantDb,
      internal: {
        pool,
        tenantDb,
        serviceTokenSecret: SECRET,
        allowedCidrs: '0.0.0.0/0',
        publishWake: (clientId, instanceId) => {
          wakeCalls.push({ clientId, instanceId });
        },
      },
    });
    const staffHeaders = makeStaffHeaders(SECRET);
    const send = (method: 'POST', path: string, staffId: string, body: Record<string, unknown>) =>
      app.inject({
        method,
        url: path,
        headers: staffHeaders(method, path, staffId),
        payload: body,
      });

    // --- seed: probe tenant with 2 instances and 3 queued jobs each -------
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds, {
      balanceMinor: 40_000,
      walletState: 'active',
    });
    const secondInstanceId = await seedExtraInstance(pool, clientId);
    for (let i = 0; i < 3; i += 1) {
      await seedQueuedJob(pool, { clientId, instanceId });
      await seedQueuedJob(pool, { clientId, instanceId: secondInstanceId });
    }
    // `clients.suspend`/`reactivate` need only `ops`; `wallet.adjust` is a
    // `superadmin`-only action (`packages/domain/src/staff/rbac.ts`) - the
    // demo seeds one staff user per role, exactly as the two real tests do.
    const opsStaffId = await seedStaffUser(pool, 'ops');
    probeStaffIds.push(opsStaffId);
    const superadminStaffId = await seedStaffUser(pool, 'superadmin');
    probeStaffIds.push(superadminStaffId);

    // --- action 1: suspend --------------------------------------------------
    const suspend = await send('POST', `/internal/v1/clients/${clientId}/suspend`, opsStaffId, {
      reason: 'P28 evidence demo: suspend',
    });
    if (suspend.statusCode !== 200) {
      throw new Error(`suspend failed: ${suspend.statusCode} ${suspend.body}`);
    }

    // --- claim attempt on both instances - must claim zero -----------------
    let claimed = 0;
    for (const id of [instanceId, secondInstanceId]) {
      claimed += await attemptClaim(pool, { clientId, instanceId: id, band: 3, fence: 1 });
    }

    // --- action 2: wallet adjustment ----------------------------------------
    const externalRef = `p28-demo-${shortId(randomUUID())}`;
    const adjust = await send(
      'POST',
      `/internal/v1/clients/${clientId}/wallet/adjust`,
      superadminStaffId,
      {
        reason: 'P28 evidence demo: goodwill credit',
        amountMinor: '2500',
        externalRef,
      },
    );
    if (adjust.statusCode !== 200) {
      throw new Error(`wallet adjust failed: ${adjust.statusCode} ${adjust.body}`);
    }

    // --- probes --------------------------------------------------------------
    const audit = await demoAuditRows(pool, clientId);
    const notifications = await demoNotificationRows(pool, clientId);
    const ledger = await ledgerRows(pool, clientId);
    const jobCounts = await jobStatusCounts(pool, clientId);
    const account = await walletAccount(pool, clientId);

    // --- action 3: reactivate (demonstrates the wake fan-out) --------------
    wakeCalls.length = 0;
    const reactivate = await send(
      'POST',
      `/internal/v1/clients/${clientId}/reactivate`,
      opsStaffId,
      { reason: 'P28 evidence demo: reactivate' },
    );
    if (reactivate.statusCode !== 200) {
      throw new Error(`reactivate failed: ${reactivate.statusCode} ${reactivate.body}`);
    }

    // --- assemble the markdown block ----------------------------------------
    lines.push(
      `Probe client: \`${shortId(clientId)}\` · staff: \`${shortId(opsStaffId)}\` (role \`ops\`, suspend/reactivate) and \`${shortId(superadminStaffId)}\` (role \`superadmin\`, wallet adjust)`,
    );
    lines.push('');
    lines.push('### staff_audit_log');
    lines.push(
      mdTable(
        [
          'id',
          'staff_id',
          'action',
          'client_id',
          'target_kind',
          'target_ref',
          'reason',
          'idempotency_key',
          'result',
          'created_at',
        ],
        audit.map((row) => [
          row.id,
          shortId(row.staff_id),
          row.action,
          shortId(String(row.client_id ?? '')),
          String(row.target_kind ?? ''),
          shortId(String(row.target_ref ?? '')),
          row.reason,
          shortId(row.idempotency_key),
          row.result,
          row.created_at,
        ]),
      ),
    );
    lines.push('');
    lines.push('### notifications (ids/enums only, no payload text)');
    lines.push(
      mdTable(
        ['id', 'kind', 'severity', 'instance_id', 'dedupe_key', 'created_at'],
        notifications.map((row) => [
          row.id,
          row.kind,
          row.severity,
          shortId(String(row.instance_id ?? '')),
          row.dedupe_key,
          row.created_at,
        ]),
      ),
    );
    lines.push('');
    lines.push('### wallet_ledger');
    lines.push(
      mdTable(
        ['seq', 'kind', 'amount_minor', 'balance_after_minor', 'actor_type', 'actor_staff_id'],
        ledger.map((row) => [
          row.seq,
          row.kind,
          row.amount_minor,
          row.balance_after_minor,
          row.actor_type,
          shortId(String(row.actor_staff_id ?? '')),
        ]),
      ),
    );
    lines.push('');
    lines.push(`wallet_accounts.state after adjust: \`${account.state}\``);
    lines.push('');
    lines.push('### message_jobs status counts (probe client, both instances)');
    lines.push('```text');
    lines.push(JSON.stringify(jobCounts));
    lines.push('```');
    lines.push('');
    lines.push('### publishWake calls recorded on reactivate');
    lines.push('```text');
    lines.push(
      wakeCalls.length === 0
        ? '(none)'
        : wakeCalls
            .map((w) => `clientId=${shortId(w.clientId)} instanceId=${shortId(w.instanceId)}`)
            .join('\n'),
    );
    lines.push('```');

    // --- verify: exit 0 only if the invariant held --------------------------
    const expectedCounts = JSON.stringify({ queued: 6 });
    const actualCounts = JSON.stringify(jobCounts);
    const auditActions = [...audit.map((r) => r.action)].sort();
    const expectedActions = ['clients.suspend', 'wallet.adjust'].sort();
    const jobsOk = claimed === 0 && actualCounts === expectedCounts;
    const auditOk =
      auditActions.length === expectedActions.length &&
      auditActions.every((a, i) => a === expectedActions[i]);

    if (!jobsOk || !auditOk) {
      exitCode = 1;
      lines.push('');
      lines.push('### MISMATCH');
      lines.push('```text');
      if (!jobsOk) {
        lines.push(
          `jobs mismatch: claimed=${String(claimed)} (expected 0), counts=${actualCounts} (expected ${expectedCounts})`,
        );
      }
      if (!auditOk) {
        lines.push(
          `audit action mismatch: got=${JSON.stringify(auditActions)} expected=${JSON.stringify(expectedActions)}`,
        );
      }
      lines.push('```');
    }

    await app.close();
  } finally {
    // --- cleanup: every probe row this script created -----------------------
    await pool.query('DELETE FROM staff_audit_log WHERE staff_id = ANY($1)', [probeStaffIds]);
    await pool.query('DELETE FROM impersonation_grants WHERE staff_id = ANY($1)', [probeStaffIds]);
    await cleanupStaffUsers(pool, probeStaffIds);
    await cleanupSendProbeClients(pool, probeClientIds);
    await pool.end();
  }

  process.stdout.write(lines.join('\n') + '\n');
  process.exit(exitCode);
}

main().catch((err: unknown) => {
  console.error(
    err instanceof Error ? `${err.name}: ${err.message}\n${err.stack ?? ''}` : String(err),
  );
  process.exit(1);
});

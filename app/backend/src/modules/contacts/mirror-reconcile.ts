import { bindQueryParams, loadQuery, type TenantDb } from '@wp/db';

/**
 * mirror-reconcile.ts (P20 Unit U7, step 8) - the nightly opt-out mirror
 * reconciler (design doc S2.5): asserts `contacts.opt_out_state='opted_out'
 * <=> a matching live opt_outs row exists`, and repairs the MIRROR only -
 * never the authority (`opt_outs` is never written here; see
 * `optout-mirror.test.ts`'s static proof). Emits
 * `wp_optout_mirror_drift_total` per client, per repaired row.
 *
 * Per client, ONE `tenantDb.withTenant` call runs
 * `db/queries/reconcile-optout-mirror.sql` - the SAME derivation
 * `optout-mirror.ts`'s `syncOptOutMirror` runs for a single contact, applied
 * to every live contact for that client and BOUNDED by `limitPerClient`
 * (ADR 0018 S4: never an unbounded per-sweep scan - a large drifted backlog
 * converges over several sweeps, not one). `listClientIds` is an INJECTED
 * port (this unit takes its cross-tenant client list from the caller, not
 * from a registry or cross-tenant SQL of its own - a later unit wires cron +
 * the real client registry).
 */

export interface MirrorReconcileDeps {
  tenantDb: TenantDb;
  listClientIds: () => Promise<string[]>;
  metrics: { incOptoutMirrorDrift: (n: number) => void };
  /** Bounded per-client repair count per sweep. Defaults 5000 (ADR 0018 S4). */
  limitPerClient?: number;
}

export interface MirrorReconcileOutcome {
  clientsScanned: number;
  contactsRepaired: number;
}

/** Runs one mirror-reconcile sweep across every client `listClientIds` returns. */
export async function runOneMirrorReconcileSweep(
  deps: MirrorReconcileDeps,
): Promise<MirrorReconcileOutcome> {
  const limit = deps.limitPerClient ?? 5000;
  const clientIds = await deps.listClientIds();
  const query = await loadQuery('reconcile-optout-mirror');

  let contactsRepaired = 0;
  for (const clientId of clientIds) {
    const repaired = await deps.tenantDb.withTenant(clientId, async (tx) => {
      const result = await tx.query(
        query.text,
        bindQueryParams(query, { client_id: clientId, limit }),
      );
      return result.rowCount ?? 0;
    });

    if (repaired > 0) {
      deps.metrics.incOptoutMirrorDrift(repaired);
    }
    contactsRepaired += repaired;
  }

  return { clientsScanned: clientIds.length, contactsRepaired };
}

import { readCampaign } from './broadcasts.repo.js';
import { toDetail, type BroadcastDetail, type LifecycleDeps } from './lifecycle-detail.js';
import { BroadcastNotFoundError } from './broadcasts.errors.js';

/**
 * lifecycle-reads.ts (P23 Unit U5, step 6) - `getBroadcast`, split out of
 * `lifecycle.service.ts` (300-line cap). `listBroadcasts` lives directly in
 * `lifecycle-detail.ts` since it shares the cursor codec declared there.
 */
export async function getBroadcast(
  deps: LifecycleDeps,
  clientId: string,
  id: string,
): Promise<BroadcastDetail> {
  return deps.tenantDb.withTenant(clientId, async (tx) => {
    const row = await readCampaign(tx, clientId, id);
    if (!row) throw new BroadcastNotFoundError();
    return toDetail(tx, clientId, row);
  });
}

export { listBroadcasts, type ListBroadcastsResult } from './lifecycle-detail.js';

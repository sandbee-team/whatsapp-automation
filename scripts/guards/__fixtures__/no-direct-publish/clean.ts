// Fixture (P15 U2, step 4) - the sanctioned shape: a business module calls
// the outbox emit function only, never the hub directly.
import { emit } from '../../../../app/backend/src/modules/events/emit.js';
import type { TenantQueryable } from '../../../../db/src/tenant-db.js';

export async function cleanBusinessWrite(tx: TenantQueryable): Promise<void> {
  await emit(tx, {
    clientId: 'client-1',
    instanceId: 'inst-1',
    type: 'instance.health_changed',
    entityId: 'inst-1',
    payload: {
      instanceId: 'inst-1',
      healthState: 'connected',
      pauseReason: null,
      needsUserAction: false,
    },
    fanout: ['sse'],
  });
}

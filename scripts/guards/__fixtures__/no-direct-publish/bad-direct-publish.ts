// Fixture (P15 U2, step 4) - a business module that reaches straight for
// hub.publish( instead of going through emit(tx, ...) + the relay. This is
// exactly the shape the guard exists to catch: ADR 0010 forbids publishing
// from inside a business transaction.
import type { RealtimeHub } from '../../../../app/backend/src/modules/realtime/hub.js';

export function rogueDirectPublish(hub: RealtimeHub): void {
  hub.publish({
    type: 'instance.health_changed',
    instanceId: 'inst-1',
    healthState: 'connected',
    pauseReason: null,
    needsUserAction: false,
    clientId: 'client-1',
  });
}

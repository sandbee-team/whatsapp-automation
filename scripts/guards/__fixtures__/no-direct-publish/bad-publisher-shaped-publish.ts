// Fixture (P15 C1 FIX F8 / MAJ-6) - a business module that imports the
// redis-bridge publisher factory and calls the publisher's own method
// directly, bypassing the outbox - the shape the widened guard exists to
// catch. The ORIGINAL guard pattern only matched one specific literal call
// text (never present anywhere in this file), so it missed this shape
// entirely - the live bypass call sites use a differently-named local
// variable's own method, never that one specific identifier.
import { createRedisRealtimePublisher } from '../../../../app/backend/src/modules/realtime/redis-bridge.js';

export function rogueBypass(redis: never, env: string): void {
  const publisher = createRedisRealtimePublisher({ redis, env });
  publisher.publish({
    type: 'instance.health_changed',
    instanceId: 'inst-1',
    healthState: 'connected',
    pauseReason: null,
    needsUserAction: false,
    clientId: 'client-1',
  });
}

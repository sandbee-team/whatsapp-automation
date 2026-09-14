import type { TenantQueryable } from '@wp/db';
import { advanceToSendTestIfConnecting } from '../tenancy/index.js';
import type { InstanceQueryable } from './repo.js';

/**
 * onboarding-advance-on-link.ts (P28 U5, item 2) - split out of repo.ts
 * (already at the 300-line cap) purely for max-lines, same "sibling module"
 * idiom as `engine/session/session-worker-discovery-wiring.ts`. `repo.ts`'s
 * `markLinkedConnected` runs this ONE conditional statement immediately
 * after its own fence-guarded UPDATE commits.
 *
 * `markLinkedConnected` runs against a bare `pool` (see
 * `session-worker-runner-factory.ts`'s `ctx.sql = pool`, not a shared
 * transaction handle this call could join) - so this is its OWN
 * autocommitted statement, not part of the engine write's transaction. That
 * is safe here specifically because the advance is purely conditional
 * (`WHERE onboarding_step = 'connect_whatsapp'`) and idempotent: a crash
 * between the two statements leaves onboarding_step exactly where a retry of
 * the SAME link event would find it again, never double-applied, never lost
 * (core invariant 3).
 */
export async function advanceOnboardingAfterLink(
  sql: InstanceQueryable,
  clientId: string,
): Promise<void> {
  await advanceToSendTestIfConnecting(sql as unknown as TenantQueryable, clientId);
}

import type { TenantQueryable } from '@wp/db';
import type { SystemActor } from './transitions.js';

export interface AutoResumeInput {
  clientId: string;
  instanceId: string;
  actor: SystemActor;
}

/** A second, illegitimate paused-exit writer - the whole point of this fixture. */
export async function planted_system_resume(
  tx: TenantQueryable,
  input: AutoResumeInput,
): Promise<void> {
  void input.actor;
  await tx.query(
    `UPDATE whatsapp_instances SET
        health_state = 'connected',
        pause_reason = NULL
      WHERE id = $1
        AND client_id = $2
        AND health_state = 'paused'`,
    [input.instanceId, input.clientId],
  );
}

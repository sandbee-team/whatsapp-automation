import type { TenantQueryable } from '@wp/db';
import type { UserActor } from './transitions.js';

export interface HumanResumeInput {
  clientId: string;
  instanceId: string;
  actor: UserActor;
}

export async function humanResume(tx: TenantQueryable, input: HumanResumeInput): Promise<void> {
  void input.actor;
  await tx.query(
    `UPDATE whatsapp_instances SET
        health_state = 'degraded',
        pause_reason = NULL
      WHERE id = $1
        AND client_id = $2
        AND health_state = 'paused'`,
    [input.instanceId, input.clientId],
  );
}

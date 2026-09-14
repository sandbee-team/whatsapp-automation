/**
 * session-owner.port.ts (P06 Unit U4) - the port `LeaseManager` (and P06
 * U5's heartbeat) call into when a lease is lost. NO Baileys/socket import
 * anywhere in this phase - the engine must not know sockets exist yet; a
 * real `SessionOwner` (opening/closing an actual WhatsApp socket) is P08's
 * job. Tests fake this port entirely.
 */
export type FenceLostCause = 'redis_renew_lost' | 'pg_fence_conflict' | 'watchdog';

/**
 * SAFETY BOUNDARY: self-fencing releases a lease; it never re-links, never
 * rotates numbers, never picks another number, and never auto-resumes a
 * paused/restricted instance (safety-compliance skill, core invariant 6 -
 * no provider-evasion mechanisms, ever). This port must NOT gain a
 * `reconnect()` method in this phase - reconnect policy is P08's, decided
 * against the real socket lifecycle, not invented here ahead of it.
 */
export interface SessionOwner {
  onFenceLost(instanceId: string, cause: FenceLostCause): void;
  close(instanceId: string): Promise<void> | void;
}

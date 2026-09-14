import { bigint, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { whatsappInstances } from './whatsapp-instances.js';

/**
 * Drizzle mirror of `db/migrations/0010_claim_join_shells.sql` (the NARROW
 * DDL-only shell) plus `db/migrations/0018_instance_lease_state.sql` (P06
 * session-lease-and-fence Unit U1's additive ALTER: `released_at`).
 */
export const instanceLeaseState = pgTable('instance_lease_state', {
  instanceId: uuid('instance_id')
    .primaryKey()
    .references(() => whatsappInstances.id),
  clientId: uuid('client_id').notNull(),
  currentFence: bigint('current_fence', { mode: 'bigint' }).notNull().default(0n),
  ownerWorkerId: text('owner_worker_id'),
  leaseSeenAt: timestamp('lease_seen_at', { withTimezone: true }),
  releasedAt: timestamp('released_at', { withTimezone: true }),
});

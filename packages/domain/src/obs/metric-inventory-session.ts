import type { MetricInventoryEntry } from './metric-inventory.js';

/**
 * metric-inventory-session.ts (P25 observability-and-runbook, unit U1b) -
 * the four session/queue/inbound gap-fill metric registrations this unit
 * added, each in its owning module and each actually incremented/set at a
 * real code site (see each file's own module-doc for the exact write
 * point(s)).
 */
export const SESSION_METRIC_INVENTORY: readonly MetricInventoryEntry[] = Object.freeze([
  {
    name: 'wp_instance_link_state',
    type: 'gauge',
    labels: ['instance_id', 'client_id'],
    module: 'app/backend/src/engine/session/metrics.ts',
    alerts: true,
    help: 'Per-instance whatsapp_instances.link_state, numerically encoded (0 unlinked, 1 pairing, 2 linked; label names: instance_id, client_id)',
  },
  {
    name: 'wp_reconnect_attempts_total',
    type: 'counter',
    labels: ['reason'],
    module: 'app/backend/src/engine/session/metrics.ts',
    alerts: false,
    help: 'Reconnect attempts actually scheduled, by disconnect reason class',
  },
  {
    name: 'wp_creds_save_buffer_total',
    type: 'counter',
    labels: ['result'],
    module: 'app/backend/src/engine/session/metrics.ts',
    alerts: false,
    help: 'Creds-save-buffer outcomes (buffered/dropped/flushed/flush_failed) during a Postgres availability failure',
  },
  {
    name: 'wp_send_errors_total',
    type: 'counter',
    labels: ['error_class'],
    module: 'app/backend/src/engine/queue/metrics.ts',
    alerts: true,
    help: 'Failed send attempts by classified error class',
  },
  {
    name: 'wp_inbound_id_collision_total',
    type: 'counter',
    labels: [],
    module: 'app/backend/src/modules/inbound/metrics.ts',
    alerts: false,
    help: 'Inbound provider event ids that collided with an already-recorded id (duplicate receipt delivered twice)',
  },
]);

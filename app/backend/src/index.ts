/**
 * app-backend - the product's Node 24 + TypeScript backend. Owns the
 * database, the durable queue, and the WhatsApp sessions. The only project
 * that owns the send path: the API role never sends directly, it only
 * creates durable jobs (core invariant). Roles (api, session-worker,
 * send-worker, scheduler, relay, cron) are wired starting a later phase.
 */
export const projectName = 'app-backend' as const;

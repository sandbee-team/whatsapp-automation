/**
 * lib/sse-types.ts - the connection-state type shared between `sse.ts` (the
 * always-on client-wide stream) and `sse-connection.ts`/`sse-instance-stream.ts`
 * (the generic loop + the transient instance-scoped stream). Pulled into its
 * own file so `sse-connection.ts` never has to import FROM `sse.ts` (which
 * would create a cycle: `sse.ts` -> `sse-connection.ts` -> `sse.ts`).
 */
export type RealtimeConnectionState = 'live' | 'reconnecting' | 'offline';

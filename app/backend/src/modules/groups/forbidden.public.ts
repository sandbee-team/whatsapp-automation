/**
 * forbidden.public.ts (P24 Unit U4b) - the module's public surface for the
 * `group_forbidden` terminal-failure hook and the inbound-side group allow-
 * list. `engine/queue/result-terminal.ts` imports `handleGroupForbidden` from
 * here (never from `on-forbidden.ts` directly); `engine/session/session-
 * worker-inbound-wiring.ts` imports `createSendEnabledGroupJidsProvider` the
 * same way - same layering convention every other `modules/**` public file
 * in this tree follows.
 */
export {
  handleGroupForbidden,
  touchGroupLastMessage,
  type HandleGroupForbiddenInput,
  type TouchGroupLastMessageInput,
} from './on-forbidden.js';
export {
  createSendEnabledGroupJidsProvider,
  type SendEnabledGroupJidsProvider,
  type CreateSendEnabledGroupJidsProviderOptions,
} from './send-enabled-jids.js';

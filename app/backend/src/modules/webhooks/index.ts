/**
 * modules/webhooks/index.ts (P15 U5, step 7/8) - the webhooks module's
 * public surface: signing, the durable dispatcher (wired as the relay's
 * second loop), the endpoint CRUD service, and the relay-loop fanout port.
 */
export { signWebhookBody, verifyWebhookSignature, buildSignatureHeader } from './sign.js';
export { computeNextAttemptDelayMs, isTerminalStatusCode, MAX_ATTEMPTS } from './backoff.js';
export {
  createWebhookFanoutPort,
  hashPayload,
  claimDueDeliveries,
  markDeliverySent,
  markDeliveryFailed,
  scheduleDeliveryRetry,
  recordEndpointSuccess,
  incrementEndpointFailures,
  disableEndpointForConsecutiveFailures,
  type ClaimedDeliveryRow,
  type EndpointHealthRow,
} from './repo.js';
export {
  runDispatchTick,
  createDispatcherLoop,
  DEFAULT_DISPATCH_CLAIM_LIMIT,
  type DispatcherDeps,
  type DispatcherLoop,
} from './dispatcher.js';
export {
  createWebhookEndpoint,
  listWebhookEndpoints,
  loadWebhookEndpoint,
  patchWebhookEndpoint,
  deleteWebhookEndpoint,
  validateEndpointUrlAtConfigTime,
  EndpointNotFoundError,
  EndpointUrlRejectedError,
  WEBHOOK_SECRET_ENC_VERSION,
  type WebhookEndpointRow,
} from './service.js';
export { registerWebhooksRoutes, type WebhooksRoutesDeps } from './routes.js';
export {
  sealWebhookSecret,
  sealedBlobToBytes,
  bytesToSealedBlob,
  type SealWebhookSecretInput,
} from './secret-codec.js';

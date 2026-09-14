/**
 * modules/messages - the ONLY public surface of this module (layering rule
 * §3.2, enforced by dependency-cruiser's no-deep-module-import). P11 Unit
 * U3: the send-path MVP's enqueue route (`POST /v1/messages`).
 */
export { registerMessagesRoutes, type MessagesRoutesDeps } from './messages.routes.js';

export {
  createMessage,
  computeRequestHash,
  MAX_QUEUED_JOBS_PER_INSTANCE,
  InstanceNotFoundError,
  InstanceUnlinkedError,
  QueueDepthCapExceededError,
  IdempotencyKeyReusedError,
  type CreateMessageServiceInput,
  type CreateMessageServiceResult,
} from './messages.service.js';

export { MediaAssetNotFoundError } from './messages.media-resolve.js';

export {
  enqueueMessageJob,
  countQueuedJobsForInstance,
  priorityRankFor,
  type EnqueueInput,
  type EnqueueResult,
  type EnqueueRecipient,
} from './messages.repo.js';

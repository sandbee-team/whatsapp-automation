import type { TenantDb, TenantQueryable } from '@wp/db';
import {
  resolveMediaAssetForDispatch,
  touchMediaAssetLastUsedAt,
} from '../../modules/media/index.js';
import type { ObjectStore } from '../../platform/storage/object-store.js';
import type { WaMessagePayload } from '../../provider/provider.types.js';
import { deferJob } from './send-loop-guard-pipeline-wiring.js';

/**
 * dispatch-media.ts (P34 Unit B, ADR 0052 accepted scope item 5) - the
 * media half of `dispatch()`, split out of `dispatch.ts` purely for that
 * file's max-lines cap (the established split idiom, same reasoning as
 * `dispatch-optout-precheck.ts`'s own header).
 *
 * `resolveTransportMediaPayload` runs ONLY at DISPATCH time (never at
 * enqueue - `messages.service.ts`'s own enqueue-time check only proves the
 * asset EXISTS, never touches the object store): it resolves `mediaId` to
 * `objectStore.getStream(storageKey)` and hands the OPEN STREAM straight to
 * the transport - the job row only ever held the `mediaId` reference,
 * never bytes (accepted scope item 5, "bytes are streamed, never
 * buffered"). `last_used_at` is stamped fire-and-forget AFTER the stream is
 * successfully opened - a failure there must never fail the send (media.repo
 * .ts's own doc comment on `touchMediaAssetLastUsedAt`).
 *
 * A failed resolve (missing/foreign asset OR an object-store outage) throws
 * `MediaDispatchDeferError` - `dispatch()` catches this BEFORE calling
 * `transport.send()` and runs the DEFER path (`defer-job.sql` via
 * `deferJob`, the SAME statement the content-guard pipeline uses): lease
 * released, `attempts` NOT incremented, no wallet impact (the debit happens
 * on ack, never per attempt) - never a terminal failure and never a blind
 * requeue (accepted scope item 5's own wording, verbatim).
 */

export class MediaDispatchDeferError extends Error {
  constructor(reason: string) {
    super(`dispatch: media resolve deferred (${reason})`);
    this.name = 'MediaDispatchDeferError';
  }
}

const MEDIA_DEFER_RETRY_MS = 30_000;

export interface ResolveTransportMediaPayloadInput {
  clientId: string;
  recipientJid: string;
  payload: Record<string, unknown>;
}

/**
 * Resolves an `image`/`document` job's `payload.mediaId` to the exact
 * `WaMessagePayload` variant the transport needs. Throws
 * `MediaDispatchDeferError` when the asset is missing/foreign (should not
 * happen - the enqueue-time check already proved it existed - but a purge
 * race is possible) or when `objectStore.getStream` itself fails (an
 * object-store outage - our own infrastructure, never a provider signal).
 */
export async function resolveTransportMediaPayload(
  tx: TenantQueryable,
  objectStore: ObjectStore,
  input: ResolveTransportMediaPayloadInput,
): Promise<WaMessagePayload> {
  const mediaId = input.payload.mediaId;
  if (typeof mediaId !== 'string') {
    throw new MediaDispatchDeferError('missing_media_id');
  }
  const asset = await resolveMediaAssetForDispatch(tx, input.clientId, mediaId);
  if (!asset) {
    throw new MediaDispatchDeferError('media_asset_not_found');
  }

  let stream;
  try {
    stream = await objectStore.getStream(asset.storageKey);
  } catch {
    throw new MediaDispatchDeferError('object_store_unavailable');
  }

  const caption = typeof input.payload.caption === 'string' ? input.payload.caption : undefined;

  if (asset.kind === 'image') {
    return { to: input.recipientJid, kind: 'image', stream, caption };
  }
  return {
    to: input.recipientJid,
    kind: 'document',
    stream,
    mimeType: asset.mimeType,
    fileName: asset.fileName ?? `document.${asset.id}`,
    caption,
  };
}

/**
 * Fire-and-forget `last_used_at` stamp - awaited but its own rejection is
 * swallowed here (never propagated to the caller), per this module's own
 * doc comment ("a failure there must never fail the send").
 */
export async function touchMediaLastUsedBestEffort(
  tenantDb: TenantDb,
  clientId: string,
  mediaId: string,
): Promise<void> {
  try {
    await tenantDb.withTenant(clientId, (tx) => touchMediaAssetLastUsedAt(tx, clientId, mediaId));
  } catch {
    // Best-effort (module doc) - a stamp failure must never fail a send.
  }
}

export interface DeferMediaJobInput {
  jobId: string;
  clientId: string;
  leaseId: string;
}

/**
 * Runs the shared `defer-job.sql` deferral (via `deferJob`, imported from
 * the guard-pipeline wiring - the SAME statement, never a second competing
 * shape): lease released, `attempts` untouched, `next_attempt_at` set
 * `MEDIA_DEFER_RETRY_MS` out. Zero rows (claim already lost to another
 * worker) is a normal outcome - `deferJob` itself never throws for that.
 */
export async function deferMediaDispatch(
  tenantDb: TenantDb,
  input: DeferMediaJobInput,
  reason: string,
  now: number,
): Promise<void> {
  await tenantDb.withTenant(input.clientId, (tx) =>
    deferJob(tx, {
      id: input.jobId,
      clientId: input.clientId,
      reason,
      retryAt: new Date(now + MEDIA_DEFER_RETRY_MS),
      leaseId: input.leaseId,
    }),
  );
}

export interface ResolveMediaOrDeferInput extends DeferMediaJobInput {
  recipientJid: string;
  payload: Record<string, unknown>;
}

export type ResolveMediaOrDeferResult =
  { deferred: false; payload: WaMessagePayload } | { deferred: true };

/**
 * The single call `dispatch.ts` makes for a `payloadKind === 'media'` job -
 * resolves the transport payload, or defers on any `MediaDispatchDeferError`
 * (including a missing `objectStore` dependency) so `dispatch.ts` itself
 * carries none of this branching inline (max-lines discipline).
 */
export async function resolveMediaOrDefer(
  tenantDb: TenantDb,
  objectStore: ObjectStore | undefined,
  input: ResolveMediaOrDeferInput,
  now: number,
): Promise<ResolveMediaOrDeferResult> {
  try {
    const payload = await tenantDb.withTenant(input.clientId, (tx) => {
      if (!objectStore) {
        throw new MediaDispatchDeferError('no_object_store_configured');
      }
      return resolveTransportMediaPayload(tx, objectStore, {
        clientId: input.clientId,
        recipientJid: input.recipientJid,
        payload: input.payload,
      });
    });
    return { deferred: false, payload };
  } catch (err) {
    if (!(err instanceof MediaDispatchDeferError)) throw err;
    await deferMediaDispatch(tenantDb, input, err.message, now);
    return { deferred: true };
  }
}

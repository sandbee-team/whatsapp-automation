import type { TenantQueryable } from '@wp/db';
import { MEDIA_KINDS, type MediaKind } from '@wp/domain';
import { getMediaAssetById } from '../media/index.js';

/**
 * messages.media-resolve.ts (P34 Unit B, ADR 0052 accepted scope) - the
 * enqueue-time media resolution `messages.service.ts#createMessage` runs
 * INSIDE its own transaction, split into its own sibling module purely for
 * that file's max-lines cap (the established split idiom - see
 * `dispatch-optout-precheck.ts`'s own header for the same reasoning).
 *
 * Fails CLOSED (404, `MediaAssetNotFoundError`) BEFORE any `message_jobs`
 * row exists when `mediaId` is missing or belongs to another tenant - core
 * invariant 4 (tenant isolation) and this dispatch's own instruction
 * ("resolve the mediaId for THIS client at enqueue time and 404 before any
 * job row is created if it is missing or foreign"). Uses
 * `getMediaAssetById` (never `resolveMediaAssetForDispatch`) - the enqueue
 * path only needs to PROVE the asset exists for this tenant, it must never
 * see `storageKey` (that accessor is reserved for `engine/queue/dispatch.ts`
 * alone, per `media.repo.ts`'s own doc comment).
 */

export class MediaAssetNotFoundError extends Error {
  readonly code = 'NOT_FOUND';
  constructor() {
    super('No such media asset.');
    this.name = 'MediaAssetNotFoundError';
  }
}

export class UnknownMessageKindError extends Error {
  readonly code = 'VALIDATION';
  constructor(contractKind: string) {
    super(`Unknown message kind: ${contractKind}`);
    this.name = 'UnknownMessageKindError';
  }
}

/**
 * `MEDIA_KINDS` -> `payload_kind` (ADR 0052 S7.1): every media kind
 * bills/persists as the single coarse `'media'` job_kind - the fine kind
 * stays in `payload.kind` for the transport.
 *
 * THROWS on any kind that is neither `'text'` nor a media kind, rather than
 * falling back to `'text'` (2026-09-14): this function decides what the job
 * is BILLED as, so an unrecognised kind returning `'text'` charges a media
 * send at the text rate and sends it down the text transport branch - the
 * exact defect class this phase exists to close. A caller that passes the
 * coarse DB value `'media'` here (rather than the contract kind `'image'`/
 * `'document'`) hit precisely that silent downgrade; it is now loud.
 */
export function payloadKindFor(contractKind: string): 'text' | 'media' {
  if ((MEDIA_KINDS as readonly string[]).includes(contractKind)) return 'media';
  if (contractKind === 'text') return 'text';
  throw new UnknownMessageKindError(contractKind);
}

/**
 * Validates a `payload.mediaId` (image/document kinds only - a no-op,
 * `undefined`-returning call for `text`) against THIS client's own
 * `media_assets` rows, inside the caller's already-open transaction.
 * Read-only: does not stamp `last_used_at` (that happens only at dispatch -
 * see `media.repo.ts#touchMediaAssetLastUsedAt`'s own doc comment) and never
 * exposes `storageKey`.
 */
export async function resolveMediaIdForEnqueue(
  tx: TenantQueryable,
  clientId: string,
  contractKind: string,
  payload: Record<string, unknown>,
): Promise<void> {
  if (!(MEDIA_KINDS as readonly string[]).includes(contractKind)) {
    return;
  }
  const mediaId = payload.mediaId;
  if (typeof mediaId !== 'string') {
    // The contract's `.strict()` per-kind schema already requires `mediaId`
    // for every media kind - this branch is unreachable from a contract-
    // validated request but fails closed rather than silently passing.
    throw new MediaAssetNotFoundError();
  }
  const asset = await getMediaAssetById(tx, clientId, mediaId);
  if (!asset || asset.kind !== (contractKind as MediaKind)) {
    // A foreign/absent id, OR a mediaId that resolves but was uploaded under
    // a DIFFERENT kind (e.g. an `image` upload referenced by a `document`
    // send) - both fail closed identically, never a 403 (core invariant 4).
    throw new MediaAssetNotFoundError();
  }
}

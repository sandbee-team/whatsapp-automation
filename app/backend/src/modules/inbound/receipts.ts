import type { ReceiptEventType } from '@wp/domain';
import type { TenantDb, TenantQueryable } from '@wp/db';
import { receiptProviderEventId } from '../../engine/queue/delivery-event.js';
import { writeDeliveryEvent } from '../../engine/queue/delivery-event.js';
import { stampCampaignRecipientReceipt } from './receipts-campaign-stamp.js';
import type { InboundMetricsHandles } from './metrics.js';

/**
 * receipts.ts (P21 Unit U3, step 4) - `messages.update` / `message-receipt
 * .update` -> ONE `delivery_events` row per receipt, through the existing
 * `delivery_event_ids` dedupe authority (`writeDeliveryEvent`). Blueprint
 * [R-13s]; ADR 0019 (a receipt never moves money - the wallet debit fires
 * once at `sent`, nothing here touches `wallet_*`/`message_jobs`/
 * `health_state`/`pause_reason`).
 *
 * Ids and counts only - never a JID, phone number, display name or body in
 * any stored row or log line (ADR 0021, core invariant 6). `participantJid`
 * feeds the provider-event-id hash input only; it is never persisted
 * (`delivery_events.detail` stays NULL) and never logged.
 *
 * Baileys types are imported as VALUES nowhere in this file - `payload:
 * unknown` is narrowed by hand below, matching `echo-capture.ts`'s "import
 * type only" precedent (this module never imports `baileys` at all, not
 * even a type-only import, since the narrowing below is structural).
 */

export type { ReceiptEventType };

export interface InboundReceipt {
  waMsgId: string;
  remoteJid: string | null;
  eventType: ReceiptEventType;
  eventTs: string;
  participantJid: string;
}

interface RawMessageKey {
  fromMe?: boolean | null;
  id?: string | null;
  remoteJid?: string | null;
}

interface RawMessagesUpdateEntry {
  key?: RawMessageKey;
  update?: { status?: number | null };
}

/** `proto.WebMessageInfo.Status`: ERROR=0, PENDING=1, SERVER_ACK=2, DELIVERY_ACK=3, READ=4, PLAYED=5. */
function receiptEventTypeFromStatus(status: number | null | undefined): ReceiptEventType | null {
  if (status === 3) return 'delivered';
  if (status === 4 || status === 5) return 'read';
  if (status === 0) return 'failed';
  return null;
}

/**
 * `messages.update` -> receipts for OUR sends only (`key.fromMe === true`
 * and `key.id` present). No provider timestamp is carried by this event, so
 * `eventTs` is always `''` and `participantJid` is always `''` (DMs only in
 * v1 - see `providerEventIdInput`'s own doc for why the parameter exists
 * from day one regardless).
 */
export function receiptsFromMessagesUpdate(payload: unknown): InboundReceipt[] {
  if (!Array.isArray(payload)) {
    return [];
  }

  const receipts: InboundReceipt[] = [];
  for (const entry of payload as RawMessagesUpdateEntry[]) {
    const key = entry?.key;
    if (!key || key.fromMe !== true || !key.id) {
      continue;
    }
    const eventType = receiptEventTypeFromStatus(entry?.update?.status);
    if (eventType === null) {
      continue;
    }
    receipts.push({
      waMsgId: key.id,
      remoteJid: key.remoteJid ?? null,
      eventType,
      eventTs: '',
      participantJid: '',
    });
  }
  return receipts;
}

interface RawUserReceipt {
  userJid?: string | null;
  receiptTimestamp?: unknown;
  readTimestamp?: unknown;
  playedTimestamp?: unknown;
}

interface RawReceiptUpdateEntry {
  key?: RawMessageKey;
  receipt?: RawUserReceipt;
}

interface LongLike {
  low: number;
  high: number;
  unsigned?: boolean;
  toNumber?: () => number;
}

function isLongLike(value: unknown): value is LongLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { low?: unknown }).low === 'number' &&
    typeof (value as { high?: unknown }).high === 'number'
  );
}

/** Provider timestamps arrive as `number | Long | null`; this normalizes any of those shapes to the decimal string `eventTs` carries. */
export function timestampToString(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'number') {
    return String(value);
  }
  if (isLongLike(value)) {
    return typeof value.toNumber === 'function' ? String(value.toNumber()) : String(value.low);
  }
  return null;
}

/**
 * `message-receipt.update` -> `fromMe` only. Preference order: read >
 * played > delivered; a missing key.id or no timestamp at all is skipped.
 * `participantJid` is `receipt.userJid` ONLY when `key.remoteJid` ends with
 * `@g.us` (a group receipt) - DMs keep `''` so P24 (groups) is the only
 * phase that ever supplies a non-empty value.
 */
export function receiptsFromReceiptUpdate(payload: unknown): InboundReceipt[] {
  if (!Array.isArray(payload)) {
    return [];
  }

  const receipts: InboundReceipt[] = [];
  for (const entry of payload as RawReceiptUpdateEntry[]) {
    const key = entry?.key;
    const receipt = entry?.receipt;
    if (!key || key.fromMe !== true || !key.id || !receipt) {
      continue;
    }

    const readTs = timestampToString(receipt.readTimestamp);
    const playedTs = timestampToString(receipt.playedTimestamp);
    const deliveredTs = timestampToString(receipt.receiptTimestamp);

    let eventType: ReceiptEventType;
    let eventTs: string;
    if (readTs !== null) {
      eventType = 'read';
      eventTs = readTs;
    } else if (playedTs !== null) {
      eventType = 'read';
      eventTs = playedTs;
    } else if (deliveredTs !== null) {
      eventType = 'delivered';
      eventTs = deliveredTs;
    } else {
      continue;
    }

    const isGroup = typeof key.remoteJid === 'string' && key.remoteJid.endsWith('@g.us');
    receipts.push({
      waMsgId: key.id,
      remoteJid: key.remoteJid ?? null,
      eventType,
      eventTs,
      participantJid: isGroup ? (receipt.userJid ?? '') : '',
    });
  }
  return receipts;
}

export interface RecordReceiptDeps {
  tenantDb: TenantDb;
  clientId: string;
  instanceId: string;
  metrics: InboundMetricsHandles;
}

export type RecordReceiptOutcome = 'recorded' | 'duplicate' | 'unmatched';

interface MatchedWaId extends Record<string, unknown> {
  message_id: string | number | bigint;
  /**
   * Selected as `::text`, NEVER as a bare `timestamptz` (which `pg` parses
   * into a JS `Date`) - a JS `Date` only carries millisecond precision,
   * while `message_jobs.created_at` (the partition/join key every
   * downstream `message_job_created_at` column exists to mirror) is
   * populated from Postgres's own `now()` at microsecond precision. Passing
   * a JS-`Date`-round-tripped value into `writeDeliveryEvent` would silently
   * store a `delivery_events.message_job_created_at` that no longer
   * equality-matches `message_jobs.created_at`, and every exact-equality
   * JOIN on that pair (`health-signal-windows.sql`'s `delivery_ratio`/
   * `read_ratio` collectors) would then match zero rows against the very
   * receipt this function just recorded - proved live against real Postgres
   * (verbatim ISO-string `Date`s print identically while the underlying
   * value differs). A text literal round-trips through Postgres exactly, so
   * this stays a text field end-to-end and is never converted to a `Date`.
   */
  message_created_at_text: string;
}

/**
 * Resolves `(client_id, instance_id, direction='out', wa_msg_id)` in
 * `message_wa_ids` -> the job it acked, then writes ONE `delivery_events`
 * row through `writeDeliveryEvent` (the `delivery_event_ids` dedupe
 * authority). An unknown `wa_msg_id` is counted on
 * `wp_receipt_unmatched_total` and dropped - NOT a dead letter (a receipt
 * for a not-yet-acked send is expected, not a fault). Never updates
 * `message_jobs`/`send_attempts`/`wallet_*`/`instance_pacing_state`/
 * `whatsapp_instances` - a receipt is display + health evidence only (ADR
 * 0019). Throws propagate to the caller (the dispatcher dead-letters them);
 * this function never catches broadly.
 */
export async function recordInboundReceipt(
  deps: RecordReceiptDeps,
  receipt: InboundReceipt,
): Promise<RecordReceiptOutcome> {
  return deps.tenantDb.withTenant(deps.clientId, async (tx: TenantQueryable) => {
    const matched = await tx.query<MatchedWaId>(
      `SELECT message_id, message_created_at::text AS message_created_at_text FROM message_wa_ids
       WHERE client_id = $1 AND instance_id = $2 AND direction = 'out' AND wa_msg_id = $3
         AND message_id IS NOT NULL`,
      [deps.clientId, deps.instanceId, receipt.waMsgId],
    );
    const row = matched.rows[0];
    if (!row) {
      deps.metrics.receiptUnmatchedTotal.inc();
      return 'unmatched';
    }

    // Decision (P21 close, recorded as an ADR): the idempotency identity of
    // a receipt is (instance_id, wa_msg_id, event_type, participant_jid) -
    // the provider timestamp is deliberately EXCLUDED. Two Baileys event
    // shapes carry one logical receipt: `messages.update` (our own send
    // acked) always parses `eventTs` as '' (no provider timestamp on that
    // shape), while `message-receipt.update` for the SAME wa_msg_id/event
    // type carries a real provider timestamp. Including `eventTs` in the
    // hash input made those two events canonicalise to DIFFERENT
    // provider_event_ids, so the same logical 'delivered'/'read' for one DM
    // wrote TWO delivery_events rows and inflated `delivery_ratio`/
    // `read_ratio` (health-signal-windows.sql's COUNT(*)-based collectors).
    // Passing '' here always (never `receipt.eventTs`) collapses both event
    // shapes onto the same id.
    const providerEventId = receiptProviderEventId(
      deps.instanceId,
      receipt.waMsgId,
      receipt.eventType,
      '',
      receipt.participantJid,
    );

    const result = await writeDeliveryEvent(tx, {
      clientId: deps.clientId,
      instanceId: deps.instanceId,
      messageJobId: String(row.message_id),
      // See MatchedWaId's own doc: a text literal, never a JS `Date`, is
      // what keeps this equality-matching `message_jobs.created_at`.
      messageJobCreatedAt: row.message_created_at_text,
      eventType: receipt.eventType,
      providerEventId,
    });

    if (!result.inserted) {
      deps.metrics.inboundIdCollisionTotal.inc();
      return 'duplicate';
    }

    // Funnel stamping (P23a Unit U1b, step 3) - a fresh 'delivered'/'read'
    // receipt advances the matching campaign_recipients row. A receipt for
    // a non-campaign job simply matches zero rows (not an error); its
    // return value is ignored for this function's own outcome.
    await stampCampaignRecipientReceipt(tx, {
      clientId: deps.clientId,
      messageJobId: String(row.message_id),
      messageJobCreatedAtText: row.message_created_at_text,
      eventType: receipt.eventType,
    });

    deps.metrics.receiptsTotal.inc({ event_type: receipt.eventType });
    return 'recorded';
  });
}

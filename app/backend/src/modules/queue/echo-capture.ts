import type { WAMessage } from 'baileys';
import type { TenantDb } from '@wp/db';
import { computeContentHash } from '../../engine/queue/content-hash.js';

/**
 * echo-capture.ts (P12 Unit U3, step 5; ADR 0035 §3 call site 2) - per
 * `messages.upsert` message with `key.fromMe === true`, records ONE echo
 * evidence row in `message_wa_ids`. This is the ONLY file in this unit
 * allowed to touch a Baileys type (`WAMessage`) - the pure hash
 * canonicalisation (`@wp/domain#contentHashInput`) never imports `baileys`
 * (the `provider/provider.types.ts` boundary rule).
 *
 * Ids and hashes only - NO body, NO JID, NO phone number anywhere in the row
 * or in any log line this module writes. `content_hash` is derived the
 * SAME way the dispatch path derives it (`computeContentHash`, ADR 0035) so
 * an echo and the attempt it confirms can be matched by the reconciler
 * (P12 step 6) without ever comparing raw message bodies.
 *
 * Per-message try/catch is the caller's responsibility
 * (`captureEchoIfFromMe` never throws past its own boundary - see its own
 * doc) so a single malformed echo skips itself, never the socket.
 */

export interface EchoCaptureLogger {
  warn(msg: string, meta?: Record<string, unknown>): void;
}

export interface EchoCaptureMetrics {
  /** Incremented once per echo that could not be captured (redacted - ids/counts only, never content). */
  incrementEchoCaptureFailed: () => void;
}

export interface CaptureEchoDeps {
  tenantDb: TenantDb;
  clientId: string;
  instanceId: string;
  logger: EchoCaptureLogger;
  metrics: EchoCaptureMetrics;
}

const MEDIA_MESSAGE_KEYS = [
  'imageMessage',
  'videoMessage',
  'audioMessage',
  'documentMessage',
  'stickerMessage',
] as const;

/**
 * ADR 0035 §1: `kind` is `media` if any of the five media message fields is
 * present on the (unwrapped) message content, else `text`.
 */
function deriveKind(content: NonNullable<WAMessage['message']>): 'text' | 'media' {
  return MEDIA_MESSAGE_KEYS.some((key) => content[key] != null) ? 'media' : 'text';
}

/** The subset of `MEDIA_MESSAGE_KEYS` whose proto type actually carries a `caption` field - `audioMessage`/`stickerMessage` structurally cannot (verified against the pinned baileys@7.0.0-rc14 WAProto types). */
const CAPTIONABLE_MEDIA_KEYS = ['imageMessage', 'videoMessage', 'documentMessage'] as const;

/**
 * ADR 0035 §1: text is `conversation` (plain outbound text) OR
 * `extendedTextMessage.text` (link-preview-carrying text), OR a captioned
 * media message's own `caption` field, OR '' when none is present
 * (captionless media - ADR 0035 §5's deliberately-ambiguous case).
 */
function deriveText(content: NonNullable<WAMessage['message']>): string {
  if (typeof content.conversation === 'string') {
    return content.conversation;
  }
  if (typeof content.extendedTextMessage?.text === 'string') {
    return content.extendedTextMessage.text;
  }
  for (const key of CAPTIONABLE_MEDIA_KEYS) {
    const caption = content[key]?.caption;
    if (typeof caption === 'string') {
      return caption;
    }
  }
  return '';
}

/**
 * Records the echo evidence row for one `fromMe` message. `ON CONFLICT ...
 * DO UPDATE` fills `content_hash`/`observed_at` ONLY WHEN `message_id IS
 * NULL` (partial-update guard in the SET clause itself) - a row already
 * resolved by the reconciler is never overwritten, so a duplicate/replayed
 * echo can never clobber a real match.
 */
async function insertEchoEvidence(
  deps: CaptureEchoDeps,
  input: { waMsgId: string; contentHash: Buffer },
): Promise<void> {
  await deps.tenantDb.withTenant(deps.clientId, (tx) =>
    tx.query(
      `INSERT INTO message_wa_ids (client_id, instance_id, direction, wa_msg_id, content_hash, observed_at)
       VALUES ($1, $2, 'out', $3, $4, now())
       ON CONFLICT (client_id, instance_id, direction, wa_msg_id) DO UPDATE SET
         content_hash = EXCLUDED.content_hash, observed_at = EXCLUDED.observed_at
       WHERE message_wa_ids.message_id IS NULL
       -- client_id = $1`,
      [deps.clientId, deps.instanceId, input.waMsgId, input.contentHash],
    ),
  );
}

/**
 * Captures one echo if `message.key.fromMe === true`, else is a no-op.
 * Unwraps `message.deviceSentMessage?.message ?? message` first (a
 * linked-device replay wraps the real content one level deep - ADR 0035
 * §1/§3). The JID comes from `deviceSentMessage.destinationJid ??
 * key.remoteJid` - never logged, never stored: it exists only to feed the
 * SAME `computeContentHash` the dispatch path calls.
 *
 * NEVER throws: any failure (missing `key.id`, no message content, a DB
 * error) is caught, logged with ids/counts only, and counted via
 * `deps.metrics.incrementEchoCaptureFailed` - the caller (the session
 * worker's `messages.upsert` subscription) must be able to process every
 * remaining message in the batch even if one echo capture fails. There is
 * no `inbound_dead_letters` table in v1 (that is P21's inbox table) - a
 * counted metric + a redacted log line is the correct scope for this phase.
 */
export async function captureEchoIfFromMe(
  message: WAMessage,
  deps: CaptureEchoDeps,
): Promise<void> {
  if (message.key.fromMe !== true) {
    return;
  }

  try {
    const waMsgId = message.key.id;
    if (!waMsgId) {
      deps.metrics.incrementEchoCaptureFailed();
      deps.logger.warn('echo-capture: fromMe message missing key.id, skipped');
      return;
    }

    const outer = message.message;
    if (!outer) {
      deps.metrics.incrementEchoCaptureFailed();
      deps.logger.warn('echo-capture: fromMe message has no content, skipped', { waMsgId });
      return;
    }

    const deviceSent = outer.deviceSentMessage;
    const content = deviceSent?.message ?? outer;
    const jid = deviceSent?.destinationJid ?? message.key.remoteJid;
    if (!jid) {
      deps.metrics.incrementEchoCaptureFailed();
      deps.logger.warn('echo-capture: fromMe message has no resolvable jid, skipped', { waMsgId });
      return;
    }

    const contentHash = computeContentHash({
      jid,
      kind: deriveKind(content),
      text: deriveText(content),
    });

    await insertEchoEvidence(deps, { waMsgId, contentHash });
  } catch (err) {
    deps.metrics.incrementEchoCaptureFailed();
    // NOTE 8: never `.message`/`String(err)` here - a pg error's
    // `detail`/`where` fields can carry the failing row's values depending
    // on the failure mode, and this is the one catch-all in the file. Log a
    // bounded, non-PII shape only: the error's name/constructor, plus a pg
    // error `code` when present (e.g. '23505') - never the message text.
    const name = err instanceof Error ? err.name : 'unknown';
    const code =
      typeof err === 'object' && err !== null && 'code' in err ? String(err.code) : undefined;
    deps.logger.warn(
      `echo-capture: failed to capture echo: ${name}${code ? ` (code=${code})` : ''}`,
    );
  }
}

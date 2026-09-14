/**
 * realtime/assert-ids-only.ts (P05 Unit U3a) - the mechanical enforcement of
 * the Observability rule ("event payloads ... carry ids and enums only - no
 * phone number, JID, message body, contact name, group subject"). A
 * publisher that builds a non-conforming event payload gets a thrown Error
 * at publish time (app/backend/src/modules/realtime/hub.ts's `publish`),
 * never a silently-leaked fan-out. Browser-pure: no Node builtins, no I/O.
 */

const MAX_STRING_LENGTH = 64;

/** Whitespace, or the `@`/`+` characters that mark a JID/phone-number shape. */
const FORBIDDEN_STRING_PATTERN = /[\s@+]/;

/**
 * Keys that are allowed to be an OPAQUE string payload rather than an
 * id/enum - still gated by the normal allow-list (a caller must still name
 * the key in `allowedKeys`) but exempt from the length/phone-JID-shape
 * checks below. Exactly one member today: `instance.qr`'s `payload` (the
 * QR/pairing-code bearer credential - see `@wp/contracts`'s
 * `instanceQrEventSchema` doc comment). Nested object/array values are
 * still rejected even for an opaque key - this only widens the STRING
 * checks, never the structural ones.
 *
 * Keyed by `${eventType}:${key}`, NOT by key alone (FIX BATCH B / B2): a
 * bare `Set(['payload'])` would let ANY future event type that happens to
 * add its own `payload` key silently inherit this PII-gate exemption. Keying
 * by the type+key pair scopes the exemption to exactly the event it was
 * written for.
 */
const OPAQUE_PAYLOAD_KEYS = new Set(['instance.qr:payload']);

/**
 * Throws if `payload` has any key outside `allowedKeys`, any string value
 * longer than 64 chars or containing whitespace/`@`/`+`, or any value that
 * is a nested object/array. Numbers, booleans, and `null` are always fine.
 * `OPAQUE_PAYLOAD_KEYS` members (keyed by `${eventType}:${key}`) skip the
 * length/shape string checks (they are deliberately not ids/enums - see
 * that const's doc comment). `eventType` is optional for callers that have
 * no event-type discriminator (e.g. ad hoc/legacy call sites) - omitting it
 * simply means no key can match any `OPAQUE_PAYLOAD_KEYS` entry, so nothing
 * is exempt.
 */
export function assertIdsOnly(
  payload: Record<string, unknown>,
  allowedKeys: readonly string[],
  eventType?: string,
): void {
  const allowed = new Set(allowedKeys);

  for (const [key, value] of Object.entries(payload)) {
    if (!allowed.has(key)) {
      throw new Error(`assertIdsOnly: key "${key}" is not in the allowed key list`);
    }

    if (value === null || typeof value === 'number' || typeof value === 'boolean') {
      continue;
    }

    if (typeof value === 'string') {
      if (eventType !== undefined && OPAQUE_PAYLOAD_KEYS.has(`${eventType}:${key}`)) {
        continue;
      }
      if (value.length > MAX_STRING_LENGTH) {
        throw new Error(`assertIdsOnly: key "${key}" exceeds ${MAX_STRING_LENGTH} chars`);
      }
      if (FORBIDDEN_STRING_PATTERN.test(value)) {
        throw new Error(
          `assertIdsOnly: key "${key}" looks like a phone number/JID or contains whitespace`,
        );
      }
      continue;
    }

    throw new Error(
      `assertIdsOnly: key "${key}" has a nested object/array value, which is never ids-only`,
    );
  }
}

/**
 * The per-event-type allow-list `assertIdsOnly` checks a publish against
 * (blueprint "Real-time & notifications" table) - kept here rather than in
 * `app/backend` so a future browser client can validate its own locally-
 * constructed test doubles against the exact same list. `type` itself is
 * never included: the discriminator is checked separately by
 * `@wp/contracts`'s `realtimeEventSchema`, not by this allow-list.
 */
export const REALTIME_PAYLOAD_KEYS = {
  'instance.qr': ['instanceId', 'expiresAt', 'attemptsLeft', 'payload'],
  'instance.health_changed': ['instanceId', 'healthState', 'pauseReason', 'needsUserAction'],
  // P16 Unit C - the hard-signal-pause write's own outbox event (a
  // dedicated mandatory-pause notification, distinct from the generic
  // 'instance.health_changed' hint - same ids/enums-only shape).
  'instance.paused': ['instanceId', 'pauseReason', 'needsUserAction'],
  // P16 Unit D (step 8) - the human-resume write's own outbox event, the
  // mirror of 'instance.paused' above - ids/enums-only, same shape.
  'instance.resumed': ['instanceId', 'healthState'],
  'instance.pacing_changed': ['instanceId', 'band', 'tier', 'effDailyCap', 'configVersion'],
  'message.job.status_changed': ['jobPublicId', 'instanceId', 'status'],
  'job.needs_user_action': ['jobPublicId', 'reason'],
  'campaign.progress': ['campaignId', 'sent', 'queued', 'failed'],
  // P15 U5 (step 7): fired when the webhook dispatcher auto-disables an
  // endpoint at 20 consecutive terminal failures - `sse` fanout only.
  'webhook.endpoint_disabled': ['endpointId'],
  // P17 Unit U2 (step 2) - the notifications-and-instance-card feature's own
  // outbox event: a new row appeared in `notifications` for the caller's
  // tenant. `instanceId` is optional on the wire (some kinds are not
  // instance-scoped, e.g. `plan_cap_reached` at the client level) but still
  // named in the allow-list - the allow-list only names which keys MAY
  // appear, never which are required.
  'notification.created': ['notificationId', 'kind', 'severity', 'instanceId'],
} as const satisfies Record<string, readonly string[]>;

export type RealtimePayloadEventType = keyof typeof REALTIME_PAYLOAD_KEYS;

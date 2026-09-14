import { bindQueryParams, loadQuery, type TenantQueryable } from '@wp/db';
import type { GuardDecision } from '@wp/domain';

/**
 * recipient-frequency.ts (P14 Unit U5, phase step 6, mandatory test 21) -
 * `evaluateRecipientFrequency`: the rolling 24h/7d per-recipient send-
 * frequency cap. PER CLIENT deliberately (see `recipient-frequency-
 * window.sql`'s own header) - the guard that stops a tenant from raising
 * how often it messages one person by spreading the traffic across a
 * second instance.
 *
 * COUNTING CONVENTION (binding): `recipient_send_buckets` counts are sends
 * ALREADY RECORDED - the send this evaluation is deciding about is NOT yet
 * in the buckets. The evaluator therefore denies at `recordedCount >=
 * limit` (never `>`): "3 per rolling 24h" means at most 3 sends may land in
 * any 24h window, so once 3 are already recorded a 4th (this pending one)
 * must be denied - `>` would let a 4th send through and only block a 5th,
 * silently loosening every configured limit by one. This is also what
 * mandatory test 21 requires: 4 sends to one contact from 4 different
 * instances of the same client -> the 4th defers (3 already recorded when
 * the 4th is evaluated, 3 >= limit of 3).
 *
 * `isGroup` skips this guard entirely (`{ok:true}`) - groups are excluded
 * from the per-RECIPIENT frequency guard; the group daily cap (part of the
 * reserve-pacing pipeline, not this guard) is the control for group volume.
 *
 * Rolling, not calendar: no local-midnight reset anywhere here - a bucket
 * from 22:00/23:00 the previous local day still counts toward a 00:30
 * evaluation the next day (see `recipient-frequency-window.sql`'s boundary
 * note). `retryAt` is the exact moment enough of the BREACHED window's
 * oldest recorded sends age out that the recorded count drops BELOW
 * `limit` again: among in-window buckets ordered oldest-first, walk
 * cumulative counts until the running total reaches `recordedCount - limit
 * + 1` (the number of oldest sends that must age out) - the bucket whose
 * inclusion reaches that many is the one that must age out, and its
 * `retryAt` is `hour_bucket + windowLength` (24h or 7d). When both windows
 * are breached, the LATER of the two expiries wins (the caller cannot
 * retry until BOTH windows allow it).
 */

export interface EvaluateRecipientFrequencyInput {
  clientId: string;
  phoneHash: Buffer;
  isGroup: boolean;
  limits: {
    perRecipient24h: number;
    perRecipient7d: number;
  };
  now: Date;
}

interface BucketRow extends Record<string, unknown> {
  hour_bucket: Date;
  count: number;
  in_24h: boolean;
  in_7d: boolean;
}

const WINDOW_24H_MS = 24 * 60 * 60 * 1000;
const WINDOW_7D_MS = 7 * 24 * 60 * 60 * 1000;

/** Bucket granularity (see `recipient-frequency-window.sql`'s own header) - the bounded hold `computeExpiry` returns when it is breached but cannot identify the exact aging-out bucket (Finding 5, P14 review-fix F2). */
const UNCOMPUTABLE_EXPIRY_HOLD_MS = 60 * 60 * 1000;

/**
 * Walks `buckets` (already filtered to one window, oldest first) and
 * returns the exact expiry `Date` of the oldest recorded send that must
 * age out for the recorded count to drop BELOW `limit` again - i.e. the
 * bucket whose inclusion first reaches `recordedCount - limit + 1` aged-out
 * sends. `null` when `recordedCount < limit` (this window is not breached).
 *
 * FINDING 5 (P14 review-fix F2): when the window IS breached but the walk's
 * cumulative total never reaches `mustAgeOut` (an inconsistent read between
 * the caller's aggregate `recordedCount` and the bucket rows it walks - a
 * stale/racing read, or an invalid non-positive `limit` bypassing this
 * module's own caller-side validation), the caller MUST NOT fall back to
 * `now` - that shape is an immediate-retry hot loop (the same job would be
 * re-evaluated, re-breach, and re-defer to `now` on every claim pass).
 * Callers instead get a bounded hold one bucket-granularity (1h) past `now`
 * - see `evaluateRecipientFrequency`'s own resolution of this return value.
 */
function computeExpiry(
  buckets: readonly BucketRow[],
  recordedCount: number,
  limit: number,
  windowMs: number,
): Date | null {
  if (recordedCount < limit) {
    return null;
  }
  const mustAgeOut = recordedCount - limit + 1;
  let cumulative = 0;
  for (const bucket of buckets) {
    cumulative += bucket.count;
    if (cumulative >= mustAgeOut) {
      return new Date(bucket.hour_bucket.getTime() + windowMs);
    }
  }
  return null;
}

export async function evaluateRecipientFrequency(
  tx: TenantQueryable,
  input: EvaluateRecipientFrequencyInput,
): Promise<GuardDecision> {
  if (input.isGroup) {
    return { ok: true };
  }

  const query = await loadQuery('recipient-frequency-window');
  const params = bindQueryParams(query, {
    client_id: input.clientId,
    phone_hash: input.phoneHash,
    now: input.now,
  });
  const result = await tx.query<BucketRow>(query.text, params);

  const buckets24h = result.rows.filter((row) => row.in_24h);
  const buckets7d = result.rows.filter((row) => row.in_7d);

  const count24h = buckets24h.reduce((sum, row) => sum + row.count, 0);
  const count7d = buckets7d.reduce((sum, row) => sum + row.count, 0);

  // Deny at >= limit, never > limit - see this module's own doc comment
  // ("COUNTING CONVENTION") for why: buckets hold sends already recorded,
  // and the send under evaluation is the NEXT one, not yet recorded.
  const breached24h = count24h >= input.limits.perRecipient24h;
  const breached7d = count7d >= input.limits.perRecipient7d;

  if (!breached24h && !breached7d) {
    return { ok: true };
  }

  // FINDING 5 (P14 review-fix F2): a breached window whose own computeExpiry
  // call returns null means the bucket walk could not identify the exact
  // aging-out bucket (an inconsistent aggregate-vs-bucket read, or an
  // invalid non-positive limit) - the BOUNDED hold (see computeExpiry's own
  // doc), never `null` treated as "not breached" here, since `breached24h`/
  // `breached7d` already established this window IS breached.
  const uncomputableFallback = new Date(input.now.getTime() + UNCOMPUTABLE_EXPIRY_HOLD_MS);
  const expiry24h = breached24h
    ? computeExpiry(buckets24h, count24h, input.limits.perRecipient24h, WINDOW_24H_MS)
    : null;
  const expiry7d = breached7d
    ? computeExpiry(buckets7d, count7d, input.limits.perRecipient7d, WINDOW_7D_MS)
    : null;
  const resolved24h = breached24h ? (expiry24h ?? uncomputableFallback) : null;
  const resolved7d = breached7d ? (expiry7d ?? uncomputableFallback) : null;

  const retryAt =
    resolved24h && resolved7d
      ? resolved24h.getTime() >= resolved7d.getTime()
        ? resolved24h
        : resolved7d
      : (resolved24h ?? resolved7d ?? uncomputableFallback);

  return { ok: false, reason: 'PER_RECIPIENT_FREQ', retryAt };
}

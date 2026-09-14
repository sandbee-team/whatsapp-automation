-- release-pacing.sql (P13 Unit U3, step 5) - the refund.
--
-- BIND PARAMETERS: `loadQuery('release-pacing').paramNames` is the
-- AUTHORITATIVE, RUNTIME-VERIFIED bind order (`db/src/queries.ts`'s
-- `convertNamedParams`, first-occurrence order, comment/string-literal
-- aware as of the Finding 2 fix, P13 C1 review) - a `db/src/queries.test.ts`
-- test asserts it exactly; do NOT hand-maintain a second numbered copy of
-- this list (the numbered list this replaced was already wrong even after
-- stripping comments - nobody had re-derived it against the landed SQL
-- text). As of this revision the true order is: message_job_id, client_id,
-- is_exempt, is_new_conversation, is_group, gap_ms, instance_id, ledger_date.
--
-- FINDING 9 (P14 review-fix F2): `$is_exempt` MUST equal the ORIGINAL
-- reserve's own `isExempt` bind value (`isExemptOrigin(sendOrigin)`), read
-- back from the job's own stored classification, never re-derived - exactly
-- the same discipline `$is_new_conversation`/`$is_group` already require
-- (point 5 below). An exempt refund is symmetric with `reserve-pacing.sql`'s
-- own exempt grant branch (point 11 there): it decrements `system_count`
-- (never `consumed_count`, which an exempt reserve never incremented) and
-- leaves `next_eligible_at` untouched (an exempt reserve never advanced it
-- either, so there is nothing to restore). `refund_count` still increments
-- in both cases - it is evidence of a refund happening, not of which
-- counter it targeted.
--
-- PER-PARAMETER SEMANTICS (unordered, cross-reference by name):
--   $ledger_date          (date)  - message_jobs.pacing_ledger_date from the
--                                    ORIGINAL reserve, never caller-supplied
--                                    "today" and never now()
--   $message_job_id       (uuid)  - the job being refunded; doubles as the
--                                    double-refund idempotency guard target
--                                    via message_jobs.pacing_refunded_at
--   $is_new_conversation  (bool)  - must match the ORIGINAL reserve's bind
--                                    value exactly
--   $is_group             (bool)  - must match the ORIGINAL reserve's bind
--                                    value exactly
--   $is_exempt            (bool)  - must match the ORIGINAL reserve's bind
--                                    value exactly (Finding 9 - see above)
--   $gap_ms               (int, milliseconds) - restores next_eligible_at,
--                                    ignored on an exempt refund (point 11
--                                    of reserve-pacing.sql: an exempt
--                                    reserve never advances it)
-- RETURNING columns, in order: consumed_count, sent_this_hour,
-- new_conv_count, group_sent_count, next_eligible_at, refund_count.
-- Zero rows = the job was already refunded (or never reserved) - a normal,
-- idempotent no-op, never an error.
--
-- (1) release() is for POST-COMMIT outcomes only. A losing claim race
--     rolls the whole transaction back rather than compensating. Getting
--     this wrong shows up as an over-send weeks later, not as a failing
--     test. Callers may invoke this statement ONLY for a job whose reserve
--     already committed and whose provider outcome is now known to be a
--     non-attempt (e.g. PERMANENT_VALIDATION_ERROR discovered before any
--     socket write, INSTANCE_PAUSED_BEFORE_SEND) - never for a claim that
--     is being rolled back in-flight.
--
-- (2) PROVIDER_ATTEMPTED is never refunded - fail-closed, structurally: this
--     statement has no bind parameter for "outcome" at all. There is no
--     code path through this SQL text that can be parameterised into
--     refunding a provider-attempted send; the caller must simply never
--     invoke release-pacing.sql for that outcome class. (The alternative -
--     accepting an $outcome parameter and branching in-statement - would
--     make "refund a provider-attempted send" one bad bind away instead of
--     structurally unreachable; deliberately not done.)
--
-- (3) Joins on message_jobs.pacing_ledger_date returned from the original
--     reservation via $ledger_date - never a caller-supplied "today" and
--     never now(). The instance's local day may have rolled over between
--     reserve and refund; crediting the WRONG day's ledger row would both
--     under-count today and over-credit a day that already closed.
--
-- (4) Restores next_eligible_at to now() minus the original gap, i.e.
--     "as if this reservation never advanced the gap clock" - the
--     complement of reserve-pacing.sql's `next_eligible_at = now() +
--     gap_ms`. This is deliberately NOT a straight "set to now()": a
--     refund must not make the NEXT send eligible any sooner than it
--     otherwise would have been by an unrelated concurrent reservation
--     that already advanced the ledger's gap clock further forward - only
--     rewinding by exactly this reservation's own gap contribution keeps a
--     rapid reserve-then-refund pair from opening a window narrower than
--     the pacing profile intends elsewhere. Never a caller-chosen constant.
--
-- (5) NON-EXEMPT: decrements the same four counters reserve-pacing.sql
--     incremented - consumed_count always; new_conv_count when
--     $is_new_conversation was true on the original reserve; group_sent_count
--     when $is_group was true - and increments refund_count.
--     $is_new_conversation/$is_group here MUST be the exact values bound on
--     the original reserve call, or the ledger drifts (e.g. refunding
--     new_conv_count for a job that was never counted as a new conversation
--     would under-count going forward). Callers read these back from the
--     job's own stored classification, never re-derive them at refund time.
--
-- (5b) EXEMPT (Finding 9, P14 review-fix F2): symmetric with reserve-
--     pacing.sql's own exempt grant branch (point 11 there) - decrements
--     `system_count` instead of `consumed_count` (an exempt reserve never
--     touched `consumed_count`, `new_conv_count`, or `group_sent_count`, so
--     none of those three are touched here either) and leaves
--     `next_eligible_at` untouched (an exempt reserve never advanced it).
--     `refund_count` still increments either way.
--
-- (6) Double-refund guard: message_jobs.pacing_refunded_at (P03) is the
--     idempotency key, enforced as a CONDITIONAL UPDATE - not an
--     in-memory check (core invariant 3). The message_jobs UPDATE in the
--     `mj` CTE below only succeeds (and only then does the ledger UPDATE
--     run, via the FROM mj join) when pacing_refunded_at IS NULL; a second
--     call with the same $message_job_id finds mj empty, so the ledger
--     UPDATE's FROM clause yields zero rows and the whole statement is a
--     no-op RETURNING no rows.
WITH mj AS (
  UPDATE message_jobs
     SET pacing_refunded_at = now()
   WHERE id = $message_job_id
     AND client_id = $client_id
     AND pacing_refunded_at IS NULL
  RETURNING id
)
UPDATE pacing_ledger l
   SET consumed_count   = GREATEST(l.consumed_count - (NOT $is_exempt)::int, 0),
       new_conv_count   = GREATEST(l.new_conv_count - (CASE WHEN $is_exempt THEN 0 ELSE ($is_new_conversation)::int END), 0),
       group_sent_count = GREATEST(l.group_sent_count - (CASE WHEN $is_exempt THEN 0 ELSE ($is_group)::int END), 0),
       system_count     = GREATEST(l.system_count - ($is_exempt)::int, 0),
       refund_count     = l.refund_count + 1,
       next_eligible_at = CASE
                             WHEN $is_exempt THEN l.next_eligible_at
                             ELSE GREATEST(l.next_eligible_at - ($gap_ms || ' milliseconds')::interval, now())
                           END,
       updated_at       = now()
  FROM mj
 WHERE l.client_id = $client_id AND l.instance_id = $instance_id AND l.ledger_date = $ledger_date
RETURNING l.consumed_count, l.sent_this_hour, l.new_conv_count, l.group_sent_count, l.next_eligible_at, l.refund_count;

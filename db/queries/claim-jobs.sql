-- claim-jobs.sql (P03 Unit B, step 5) - the canonical claim statement.
--
-- (1) This is the ONLY statement in the system allowed to set
--     status='processing' - enforced by scripts/check-single-claim.ts, which
--     fails the build if any other scanned file sets message_jobs.status to
--     'processing' via: a raw SQL or TS/TSX string/template-literal UPDATE
--     ... SET ... status = 'processing' (any case, any quote style); the
--     same shape with the literal bound as a numbered query parameter
--     instead (the literal value bound separately in TS); or the
--     Drizzle ORM equivalent, the messageJobs table's update(...).set({...})
--     call with a status key (literal or variable). Scanned trees: the ADR
--     0014 source trees' TS/TSX (app, admin, website, packages, db/src,
--     db/tests, db/schema), every raw db/queries, db/migrations and
--     db/seeds .sql file, and scripts/.
--
-- (2) The lock clause is and stays `FOR UPDATE OF j SKIP LOCKED` - an
--     unqualified `FOR UPDATE` would row-lock the client's single hot
--     wallet_accounts row on every claim from every instance, serialising the
--     whole workspace and creating a deadlock pair with the wallet debit.
--
-- (3) `wallet_accounts` is an INNER JOIN so a missing wallet row is
--     fail-closed; `campaigns` is a LEFT JOIN with an allow-list status
--     predicate (`IN ('running','expanding')`) so a missing or
--     unknown-status campaign yields zero claims.
--
-- (4) Every eligibility predicate (fence, health, epoch, client status,
--     wallet, campaign) lives INSIDE this statement - checking any of them
--     outside is a rejected review finding.
--
-- (5) `attempts` is NOT incremented here - it increments exactly once with
--     the send_attempts INSERT, later phase.
--
-- (6) ORDER BY is next_attempt_at, id within an externally chosen band -
--     absolute-priority ordering is banned as starvation.
--
-- (7) Zero rows is a normal outcome.
--
-- (8) ADR 0026: i/ls joins tenant-qualified.
--
-- (9) FINDING-1 FIX (P13 C1 review): `pacing_ledger_date` is NOT set here.
--     It used to be bound from a Node-computed `new Date().toISOString()
--     .slice(0, 10)` UTC calendar date - WRONG, because
--     `db/queries/reserve-pacing.sql` buckets by the instance's LOCAL date
--     (`(now() AT TIME ZONE pacing_timezone)::date`), and the two disagree
--     for hours of every day whenever `pacing_timezone` is not UTC. The
--     reserve statement is the ONLY authority for what "today" means for
--     pacing (see that file's own point (3)); this claim statement no
--     longer guesses a date at all. The caller
--     (`engine/queue/send-loop-pacing-claim.ts#claimAndReserve`) writes
--     `message_jobs.pacing_ledger_date` back from `reserve-pacing.sql`'s
--     own RETURNING `ledger_date` column, in the SAME transaction,
--     immediately after a GRANT - never before, never guessed.
--
-- (10) P14 Unit U4: RETURNING widened, additive-only, with
--      recipient_hash/send_origin/content_fingerprint - the statement body
--      itself (predicates, lock clause, SET list) is UNCHANGED. Callers
--      (queue.repo.ts's `ClaimedJob`) need these three columns to run the
--      opt-out gate and the exempt-origin pacing reserve without a second
--      round trip.

WITH eligible AS (
  SELECT j.id, j.created_at
    FROM message_jobs j
    JOIN whatsapp_instances   i  ON i.id = j.instance_id  AND i.client_id  = j.client_id
    JOIN instance_lease_state ls ON ls.instance_id = j.instance_id AND ls.client_id = j.client_id
    JOIN clients              c  ON c.id = j.client_id
    JOIN wallet_accounts      w  ON w.client_id = j.client_id
    LEFT JOIN campaigns       cp ON cp.id = j.campaign_id AND cp.client_id = j.client_id
   WHERE j.client_id       = $client_id
     AND j.instance_id     = $instance_id
     AND j.status          = 'queued'
     AND j.priority_rank   = $band
     AND j.next_attempt_at <= now()
     AND j.scheduled_at    <= now()
     AND ls.current_fence  = $fence           -- caller currently owns the session
     AND i.health_state    = 'connected'
     AND i.session_epoch   = j.session_epoch  -- no wrong-number send after a relink
     AND i.deleted_at IS NULL
     AND c.status          = 'active'
     AND w.state NOT IN ('empty','frozen')    -- wallet stop: orthogonal, NOT health_state
     AND w.balance_minor  >= w.max_rate_minor
     AND (j.campaign_id IS NULL OR cp.status IN ('running','expanding'))   -- allow-list, fail-closed
   ORDER BY j.next_attempt_at, j.id
   FOR UPDATE OF j SKIP LOCKED
   LIMIT 1)
UPDATE message_jobs j
   SET status='processing', lease_owner=$worker, lease_id=gen_random_uuid(),
       owner_fence=$fence, leased_at=now(),
       lease_expires_at = now() + ($claim_expiry_ms || ' ms')::interval,
       pacing_reserved_at = now(), updated_at = now()
  FROM eligible e
 WHERE j.id = e.id AND j.created_at = e.created_at AND j.status = 'queued'
RETURNING j.id, j.created_at, j.lease_id, j.instance_id, j.session_epoch,
          j.recipient_jid, j.payload, j.payload_kind, j.attempts, j.campaign_id,
          j.is_new_conversation, j.recipient_hash, j.send_origin, j.content_fingerprint;

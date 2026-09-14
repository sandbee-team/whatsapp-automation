-- defer-job.sql (P14 Unit U6, phase step 7) - the single statement backing
-- BOTH the pacing denial write (`send-loop-pacing-claim.ts#writeDenialToJob`,
-- inlined until this unit) and the guard pipeline's own non-terminal
-- (`DENY_REASON_EFFECTS[reason].jobOutcome === 'queued'`) deferral write -
-- ONE deferral shape, never two competing ones.
--
-- BIND PARAMETERS (loadQuery('defer-job').paramNames is the authoritative
-- runtime-verified order): id, client_id, retry_at, reason, lease_id.
--
-- C2 NOTE (P14 review-fix F2): the WHERE clause now also matches
-- `status = 'processing' AND lease_id = $lease_id` - symmetric with
-- `dispose-job.sql`'s own lease-guarded WHERE. Previously this statement was
-- safe ONLY by virtue of its sole caller (`send-loop-claim-evaluation.ts`)
-- always running it inside the SAME transaction as the claim that set this
-- exact lease, with no other writer able to interleave - correct today, but
-- one future caller away from a lost-claim race silently deferring a job
-- another worker has since re-claimed and is actively processing. The guard
-- makes that structurally impossible instead of merely true by convention:
-- zero rows now ALSO covers "the claim was already lost to another worker"
-- (see the existing zero-rows note below, extended to this new case).
--
-- `attempts` is NEVER touched here - a pacing/content deferral never
-- consumes retry budget (core invariant 5, "pause preserves work", extended
-- to ordinary pacing waits - see deny-reasons.ts's own module doc).
--
-- LEASE FIELDS CLEARED (extension over the pre-U6 inline `writeDenialToJob`
-- shape, phase file's own normative instruction: "a deferred job holds no
-- lease and no unit"): lease_owner, lease_id, owner_fence, leased_at,
-- lease_expires_at all set NULL, and pacing_reserved_at cleared too - a
-- deferred job was never granted a pacing unit (pacing's own denial path)
-- or was disposed of its guard-pipeline evaluation before ever reaching
-- reserve() (the content-guard defer path), so there is nothing to refund
-- and nothing left held. This closes a real correctness gap the pre-U6
-- inline UPDATE had: it left the lease row exactly as claim-jobs.sql set it
-- (status='queued' but lease_id/lease_expires_at still populated), which
-- would have let a stale lease outlive the job's own 'queued' status.
--
-- Zero rows = the claim was already lost to another worker (a normal
-- outcome, same discipline as dispose-job.sql's own claim-lost note) - the
-- caller must never treat an empty result as an error.
UPDATE message_jobs
   SET status = 'queued',
       next_attempt_at = $retry_at,
       pacing_deny_reason = $reason,
       pacing_deferrals = pacing_deferrals + 1,
       lease_owner = NULL,
       lease_id = NULL,
       owner_fence = NULL,
       leased_at = NULL,
       lease_expires_at = NULL,
       pacing_reserved_at = NULL,
       updated_at = now()
 WHERE id = $id AND client_id = $client_id AND status = 'processing' AND lease_id = $lease_id
RETURNING id;

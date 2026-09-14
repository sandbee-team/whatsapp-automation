-- broadcast-funnel-pending.sql (P23a Unit U2; P23a C1 fix round unit F2 -
-- funnel-active rotated to a keyset scan) - cross-tenant discovery for the
-- progress-funnel recompute sweep, TWO named sections (never a single query
-- - the active/hourly loops have different bounds and different staleness
-- windows, see funnel.sweep.ts's own header).
--
-- `funnel-active`: campaigns still doing visible work
-- (snapshotting|expanding|running|paused), KEYSET-ROTATED by `id > $cursor
-- ORDER BY id LIMIT $limit`, served by the partial index
-- `campaigns_funnel_discovery_idx` (migration 0065:
-- `CREATE INDEX ... ON campaigns USING btree (id) WHERE status IN (...)`).
-- Deliberately NOT `ORDER BY updated_at ASC`: `reconcileCounters` never
-- touches `campaigns.updated_at`, and a `paused` campaign never leaves this
-- status set, so an `updated_at`-ordered scan lets >LIMIT paused/long-running
-- campaigns permanently occupy the head - any campaign past position LIMIT
-- (including another tenant's actively RUNNING broadcast) would never be
-- recomputed by the 5s loop. A keyset walk by primary key has no such head:
-- `funnel.sweep.ts`'s in-process rotation cursor (`activeCursor`) advances to
-- the last id this tick returned and wraps to the zero uuid once a tick
-- returns fewer than `limit` rows, guaranteeing every active campaign is
-- reached within `ceil(activeCampaignCount / limit)` ticks regardless of
-- tenant or how long any single campaign has sat in this status set.
--
-- `funnel-hourly`: belt-and-braces crash reconciliation for rows the active
-- loop no longer visits - a campaign that reached a terminal status
-- (completed|cancelled|failed) is unioned in when either its `updated_at`
-- is within the last 25 hours (still "recent enough" to be worth a
-- confirmation recompute) OR its `campaign_counters.recomputed_at IS NULL`
-- (it has NEVER been reconciled at all - the belt-and-braces case a crash
-- between `createCampaign` and the first active-loop tick would otherwise
-- leave unrecoverable). LEFT JOIN so a campaign whose counters row is
-- somehow missing still surfaces (`recomputeCampaignFunnel`'s own
-- `reconcileCounters` handles that absence by inserting one).
--
-- ORDER BY leads with an open-status-first rank (P23a C2b fix, 2026-09-14):
-- a still-OPEN campaign (`snapshotting|expanding|running|paused`) is live
-- work the active loop's cursor may not yet have reached (it wraps a full
-- pass over `ceil(activeCampaignCount / activeLimit)` ticks, and a crashed/
-- long-paused cron replica can widen that further) - this hourly pass is
-- its belt-and-braces backstop too, not just the terminal branch's. The
-- terminal branch's `recomputed_at IS NULL` predicate is UNBOUNDED and only
-- ever grows across a long-lived database (every campaign ever reconciled
-- once and never touched again satisfies it forever), so a plain
-- `updated_at ASC` scan across both branches together lets that backlog
-- permanently outrank freshly open-status campaigns (which always have the
-- LATEST `updated_at`, i.e. sort last) once the backlog exceeds `$limit` -
-- the exact `funnel-active` starvation shape this file's own header already
-- diagnosed and fixed there, previously left open here. Ranking open-status
-- first (`0`) before terminal (`1`), each sub-ordered by `updated_at ASC`,
-- guarantees every open-status campaign is reconciled every tick regardless
-- of terminal-backlog size, while the terminal branch keeps draining in its
-- own oldest-first order within the remaining `$limit` budget.

-- name: funnel-active
SELECT c.id, c.client_id
  FROM campaigns c
 WHERE c.status IN ('snapshotting', 'expanding', 'running', 'paused')
   AND c.id > $cursor
 ORDER BY c.id ASC
 LIMIT $limit;

-- name: funnel-hourly
SELECT c.id, c.client_id
  FROM campaigns c
  LEFT JOIN campaign_counters cc ON cc.campaign_id = c.id AND cc.client_id = c.client_id
 WHERE c.status IN ('snapshotting', 'expanding', 'running', 'paused')
    OR (
      c.status IN ('completed', 'cancelled', 'failed')
      AND (c.updated_at > now() - interval '25 hours' OR cc.recomputed_at IS NULL)
    )
 ORDER BY
   CASE WHEN c.status IN ('snapshotting', 'expanding', 'running', 'paused') THEN 0 ELSE 1 END,
   c.updated_at ASC
 LIMIT $limit;

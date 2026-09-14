# P15 evidence — outbox relay coalescing (the phase demo)

**What this evidences:** P15 step 5's phase-demo claim — 500 `message.job.status_changed` outbox rows for
ONE `(client_id, instance_id)` pair, all sharing the same coalesce key, drain through the relay's
`drainOnce()` as **at most 2 SSE batch frames per second** (ADR 0010's coalescing policy: "emit ONE batch
frame per group ⇒ ≤2 frames/s per instance"), with every suppressed row accounted for by
`wp_sse_coalesced_total`.

**Date:** 2026-09-02
**Command:** `pnpm vitest run src/roles/relay.integration.test.ts -t
"five_hundred_job_events_for_one_instance_produce_at_most_two_sse_frames_per_second" --reporter=verbose`
(run from `app/backend/`), against the real dev-stack PostgreSQL 17 at `127.0.0.1:55432`.

## 1. Verbatim test run

```
 RUN  v4.1.11 D:/kd/wp/app/backend

 ✓ src/roles/relay.integration.test.ts > drainOnce - the phase demo > five_hundred_job_events_for_one_instance_produce_at_most_two_sse_frames_per_second 865ms
 ↓ src/roles/relay.integration.test.ts > drainOnce - newest-wins coalescing > the_last_frame_carries_the_newest_state_for_every_coalesce_key
 ↓ src/roles/relay.integration.test.ts > drainOnce - exactly-once across concurrent relay processes > two_relay_processes_publish_each_event_exactly_once
 ↓ src/roles/relay.integration.test.ts > drainOnce - crash safety > a_crash_between_dispatch_and_mark_republishes_and_the_receiver_dedupes

 Test Files  1 passed (1)
      Tests  1 passed | 3 skipped (4)
   Start at  22:41:42
   Duration  1.90s (transform 276ms, setup 21ms, import 882ms, tests 867ms, environment 0ms)
```

## 2. What the test measures

`app/backend/src/roles/relay.integration.test.ts`'s
`five_hundred_job_events_for_one_instance_produce_at_most_two_sse_frames_per_second` seeds **500**
`message.job.status_changed` rows for one `(client_id, instance_id)` pair (all sharing the coalesce key
`instance:<instanceId>:jobs`), then simulates 1 second of relay operation as **two 500ms ticks** (ADR
0010's own literal "Tick 500 ms" cadence), each a direct call to `drainOnce()` with a fake, injected clock
— never a real `setInterval`/wall-clock wait.

Measured, asserted values (exact, not bounds):

| Quantity                                                             | Value                                          |
| -------------------------------------------------------------------- | ---------------------------------------------- |
| Rows claimed, tick 1 (`FOR UPDATE SKIP LOCKED`, `LIMIT 500`)         | **500**                                        |
| Rows claimed, tick 2 (nothing left to claim)                         | **0**                                          |
| Batch frames published to `(clientId, instanceId)` across both ticks | **1**                                          |
| Events inside that one frame                                         | **1** (the newest row — coalescer newest-wins) |
| `wp_sse_coalesced_total` increment (suppressed/loser rows)           | **499**                                        |
| Unpublished rows remaining for this client after both ticks          | **0**                                          |

One published frame for two ticks of a 500-row burst is **≤ 2 frames/s per instance**, satisfying ADR
0010's coalescing ceiling with margin (the 500-row burst collapsed to a single frame because every row
shared one coalesce key — the realistic multi-key case, exercised by
`more_than_25_keys_in_one_group_sets_truncated_and_keeps_the_25_newest` in
`app/backend/src/modules/events/coalescer.test.ts`, still caps at one frame per group per tick, `truncated:
true` beyond 25 distinct keys).

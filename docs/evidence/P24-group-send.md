# P24 group-send evidence trail (step 10)

**Status: Part A: RUN 2026-09-06 (integration harness, fake transport, re-run under the P24 C1 fix round
so the forbidden path attests to the REAL wired send loop) · Part B: NOT RUN — awaiting a
real linked number.**

## Why two parts (core invariant 7 — tests are evidence)

There is no real linked WhatsApp number available this session (same constraint as P11/P21/P23). A
hand-built or harness-driven capture proves the code path handles the shapes the send/claim/reserve/
dispatch/result pipeline and the receipt/forbidden hooks were built against; it cannot prove that a real
WhatsApp account actually produces those shapes on the wire (a real group send, real delivery/read
receipts from real participants, a real `403`/not-admin rejection). Writing a harness run up as proof of
the real wire behaviour would be exactly the false evidence invariant 7 exists to prevent — so this
document keeps the two apart: Part A is real Postgres, real queue/pacing/wallet/notification code, a
**fake** transport; Part B is the real-number trial, not yet run, with an empty results table.

## Memory-honesty note (ADR 0018 §2)

A `send_enabled`-groups instance budgets **22 MB optimised / 39 MB pessimistic** — never the flat **18
MB** idle figure, which ADR 0018 §2 says "may not be quoted for any group-enabled instance" (group
sender-key state is `tracked_participant_devices x record_size`, not a flat megabyte). Nothing in this
document restates a capacity or cost claim; it is cited here only so a reader does not mistake the
group-send evidence below for a capacity proof. `DEVICES_PER_PARTICIPANT_ESTIMATE = 2` (`@wp/domain`,
`deriveTrackedParticipantDevices`) is **DERIVED**, not measured — it remains an estimate until P26's own
measurement phase (ADR 0018 Gate A) publishes a real per-participant device table.

---

## Part A — integration-harness trail (RUN, verbatim)

### What this proves and does not prove

Drives ONE real group send through the REAL claim → reserve → dispatch (fake transport) → result path
(`send.integration.test.ts`'s own harness: `enqueueVia` → `runOneIteration` →
`resolveAck`/`resolveFailure`), three synthetic participant `delivered` receipts fed into
`recordInboundReceipt` for the SAME `wa_msg_id` (proving the group receipt fan-out writes one
`delivery_events` row per participant, never collapsing to one), and one `group_forbidden` terminal
failure plus an immediate replay on a SIBLING enabled group of the same instance — both driven through
`enqueueVia`/`seedQueuedJob` → `runOneIteration` (the SAME production `claimOne → reserve → dispatch →
resolveFailure → handleGroupForbidden` chain the send loop runs, never a direct `resolveFailure` call — see
Finding 2 of the P24 C1 fix round: `send-loop.ts` used to omit `recipientJid` from its own `resolveFailure`
call, so a direct-call capture never actually proved the hook fires in production). The dedupe shape
matches `forbidden-edge.integration.test.ts`'s own case. Every write below is production code already
covered by `send.integration.test.ts` / `send-guards-pricing.integration.test.ts` /
`forbidden.integration.test.ts` / `forbidden-edge.integration.test.ts` /
`forbidden-loop.integration.test.ts` / `receipts.integration.test.ts`; this capture adds no new production
code path, only a reproducible print.

Test: `app/backend/src/modules/groups/evidence-trail.integration.test.ts` (helper:
`app/backend/src/modules/groups/__tests__/evidence-trail-format.ts`). The test itself asserts the printed
block contains no `@g.us`/`@s.whatsapp.net`/`@lid` substring and no digit run longer than 6 outside a
UUID or a hex digest — so a future edit that leaks a subject/JID/phone into the block fails the test, not
just this document's own review.

### Verbatim printed block

```
=== P24-EVIDENCE-TRAIL-START ===
-- one real group send --
message_jobs.public_id_sha256=fd3a9ada82107282be0fc1a751d413a32697db5b815abdb8dd0a7664940a60eb
message_jobs.id_sha256=fd944e6422a22083d9c972afbff6851ab814891e1b1d3058687804be552a39b4
message_jobs.status=sent
message_jobs.last_error_class=null
message_jobs.recipient_e164=null
message_jobs.is_new_conversation=false
  attempt_id_hash=263d9a5fa843afcb65bef807f7606e4eb0326201cfee9dbe5caa3e63484e77d6 attempt_no=1 state=acked
  event_type=created provider_event_id_sha256=6715ef7d08b08dab76d07447a7daacc4d427b038508448584c598e08b55ee257
  event_type=queued provider_event_id_sha256=1444629b9f95cbd880dc1bd4e7af268acde19aa1ce5ea73bd179eb5a1b2648f1
  event_type=dispatched provider_event_id_sha256=2f3739ed628b0bda71f92399158913953eafade21c30fadda3cd3ef4f1e8715b
  event_type=sent provider_event_id_sha256=4039360703f0aaa70beadd42852cf91f77edc12ea07851e81579ae78ce5d0bd4
pacing_ledger.consumed_count.before=0
pacing_ledger.consumed_count.after=1
pacing_ledger.group_sent_count.before=0
pacing_ledger.group_sent_count.after=1
pacing_ledger.new_conv_count.before=0
pacing_ledger.new_conv_count.after=0
wallet_ledger.price_key=group_text
wallet_ledger.amount_minor=-15
wallet_charge_guards.count=1
-- three synthetic participant receipts, same wa_msg_id --
  participant_receipt_provider_event_id_sha256=9dae1d83f5ec28fb759f058ebc9c89796dc9c2a11306601fe80e03b25f49b0c7
  participant_receipt_provider_event_id_sha256=b1e75134938db7ac08c05b48ef2182348eb6e594a2be35651b53c4d3c6436937
  participant_receipt_provider_event_id_sha256=307924bedb6e5402056f286518a05a7981d367c9d522405edfa35862bf3c31d2
delivery_events.delivered.distinct_count=3
-- one group_forbidden path, sibling enabled group --
wa_groups.id_sha256=483f18cc568875c468a62235f9fea0faaed8805c6ec53e4bf6bcf187babe118d
wa_groups.send_enabled=false
wa_groups.disabled_reason=group_forbidden
wa_groups.next_sync_after_is_not_null=true
audit_logs.action=group.send_disabled
notifications.kind=group_forbidden
notifications.created=true
notifications.replay_deduped=true
whatsapp_instances.health_state.before=connected
whatsapp_instances.health_state.after=connected
whatsapp_instances.pause_reason.before=null
whatsapp_instances.pause_reason.after=null
=== P24-EVIDENCE-TRAIL-END ===
```

### Reading the trail

- **One send, one debit, one guard row.** `message_jobs` reaches `status=sent` with `recipient_e164=null`
  (a `@g.us` job never carries an E.164), `is_new_conversation=false` (a group send is never treated as a
  new-conversation event, per the send-loop's own group carve-out). `send_attempts` shows exactly one
  `attempt_no=1` row in `acked` state. `delivery_events` carries the job's own lifecycle rows
  (`created`/`queued`/`dispatched`/`sent`), each with a distinct `provider_event_id` hash. `wallet_ledger`
  shows exactly one row at `price_key=group_text`; `wallet_charge_guards.count=1` confirms the single-
  reserve guard fired exactly once (never a double charge).
- **Group unit consumption.** `pacing_ledger.consumed_count` and `group_sent_count` each advance by
  exactly 1 for the one send; `new_conv_count` stays at 0 — a group send consumes one general unit and
  one group unit, never a new-conversation unit.
- **Three participants, three distinct receipt ids, one wa_msg_id.** The three synthetic `delivered`
  receipts for the SAME `wa_msg_id` produce three separate `delivery_events` rows with three distinct
  `provider_event_id` hashes (`delivery_events.delivered.distinct_count=3`) — the group receipt identity
  includes the participant, so it never collapses three participants' acks into one row the way a DM
  receipt would.
- **The forbidden path touches ONE group, never the instance.** `wa_groups.send_enabled` flips to
  `false` with `disabled_reason=group_forbidden` and `next_sync_after` set (a future re-sync is still
  possible); `audit_logs.action=group.send_disabled` and exactly one `notifications` row of
  `kind=group_forbidden` are written. `whatsapp_instances.health_state`/`pause_reason` are
  **byte-identical before and after** — a `group_forbidden` rejection is terminal for the one job/group
  only, never an instance-level pause (core invariant 2's documented group carve-out,
  `on-forbidden.ts`'s own module header). The immediate replay on the same group is deduped
  (`notifications.replay_deduped=true` — no second notification row), matching
  `forbidden-edge.integration.test.ts`'s own dedupe case.

### Fixture/run commands used

```
pnpm -F app-backend exec vitest run src/modules/groups/evidence-trail.integration.test.ts --reporter=verbose
```

---

## Part B — live-number run: NOT RUN

Same skeleton discipline as `docs/evidence/P21-inbound-signals.md`: no row in the results table below may
be filled in, and no interpretation section may be written, except from the output of a real trial
against a real linked WhatsApp number. A mock socket or a harness-driven capture (Part A above) is not
evidence for this part.

### What MAY be recorded

ids, hashes (sha256 hex of any provider-supplied id, never the raw id), counts, and metric deltas
(`wp_group_sends_total{result}`) only.

### What MUST NOT be recorded, under any circumstance

The group subject; the group JID (`@g.us` address); any participant's identity (JID, phone, display
name); the message text sent; any phone number (E.164) of any party.

### Operator procedure

1. **Link a number** in the panel (an already-connected test number is fine; never the founder's primary
   number).
2. **Sync groups** for that instance (`POST /v1/instances/:id/groups/sync`) so `wa_groups` reflects the
   operator's real group memberships.
3. **Enable exactly ONE small test group the operator owns** for sending
   (`PATCH /v1/groups/:id/send-enabled`) — a group with a handful of participants, never a large or
   customer-facing group.
4. **Send one text message** through `POST /v1/messages` addressed to that group's jid. Observe the
   group's own delivered/read receipts arrive as `delivery_events` rows (one per participant who acks).
5. **Demote the number in a second test group** (remove its admin/send permission in WhatsApp itself, or
   use a group where the linked number is a plain member of an announce-only group) and send once more to
   capture a real `group_forbidden` rejection; confirm only that ONE group's `wa_groups.send_enabled`
   flips, the instance's own health/pause state is untouched, and exactly one `group_forbidden`
   notification is written.

### Results table (fill in only from a real trial)

| Item                                                                    | Expected shape              | Observed |
| ----------------------------------------------------------------------- | --------------------------- | -------- |
| `message_jobs.public_id` (sha256 hex)                                   |                             |          |
| `message_jobs.id` (sha256 hex)                                          |                             |          |
| `message_jobs.status`                                                   | `sent`                      |          |
| `send_attempts.id` (sha256 hex) + `attempt_no` + `state`                |                             |          |
| `delivery_events` rows for the job — distinct `provider_event_id` count |                             |          |
| `pacing_ledger.group_sent_count` delta                                  | `+1`                        |          |
| `wallet_ledger.price_key` / `amount_minor`                              | `group_text`                |          |
| `wallet_charge_guards` count for the send                               | `1`                         |          |
| `wa_groups.send_enabled`/`disabled_reason` (forbidden group, after)     | `false` / `group_forbidden` |          |
| `audit_logs.action` (forbidden path)                                    | `group.send_disabled`       |          |
| `notifications.kind`/`created` (forbidden path)                         | `group_forbidden` / `true`  |          |
| `whatsapp_instances.health_state`/`pause_reason` before vs after        | byte-identical              |          |
| `wp_group_sends_total{result="sent"}` delta                             | `+1`                        |          |
| `wp_group_sends_total{result="group_forbidden"}` delta                  | `+1`                        |          |

### Verdict

_(Fill in only after the results table above is complete: did the real group send reach `sent` with the
expected unit/charge shape; did the real receipts arrive as one `delivery_events` row per participant;
did the real forbidden rejection disable only the one group and leave the instance's health/pause state
untouched.)_

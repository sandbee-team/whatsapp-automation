# P21 Unit U6b — inbound signals evidence: a real STOP and a real delivered+read pair

**STATUS: NOT YET RUN — awaiting a real linked number.** No row in the results table below may be filled in,
and no section below may be written, except from the output of a real trial against a real second phone linked
through the panel. A mock socket, a synthetic Baileys event, or an inferred result is not evidence for this
document — see "Why this cannot be simulated" below (same discipline as `docs/evidence/P12-spike-2-echo.md`).

Created: 2026-09-05 (skeleton only, P21 Unit U6b, step 7). Filled in only after the founder (or an authorised
operator) runs the trial described here against a real linked WhatsApp number.

## Why this exists

Phase P21 built a headless inbound listener: delivery receipts (`messages.update` / `message-receipt.update`),
STOP/opt-out detection from a real inbound message, admission shedding above a per-instance ceiling, and dead
letters for anything that throws. Every unit up to and including this one is proven against a **fake** socket
(`makeFakeSock()`) or synthetic payload shapes constructed by hand from the Baileys event documentation. This
document is the one piece of evidence that the real Baileys wire shape the dispatcher was built against
(`key.fromMe`, `update.status`, `receipt.receiptTimestamp`/`readTimestamp`, the two receipt event names
themselves) actually matches what a real WhatsApp session emits for a real STOP and a real delivered+read pair —
never simulated, per core invariant 7 (tests are evidence).

## What is recorded (ids, hashes and counts ONLY)

Nothing below may ever include the phone number, the message text, or the JID. The following columns/metrics are
the complete list of what this document may capture:

- `opt_outs.id` (the row's own surrogate key — a UUID, not attributable on its own)
- `opt_outs.phone_hash` rendered as sha256 **hex** (never the raw bytes, never the phone number that produced it)
- Count of `message_jobs` rows that transitioned to `cancelled` with `cancel_reason = 'opt_out'`
- Count of `optout_confirmations` rows written (expected: exactly 1, the 30-day guard's first-ever row for this
  `phone_hash`)
- The two `delivery_events.provider_event_id` values (sha256-derived ids, one for `delivered`, one for `read`) —
  hex, never the raw `wa_msg_id` or JID that fed them
- `wp_receipts_total{event_type="delivered"}` and `{event_type="read"}` deltas (before/after counts only)
- `inbound_dead_letters` count for this client during the trial window — **must equal 0** (any non-zero count is
  itself a finding to investigate, not a number to explain away)

### MUST NOT be recorded, under any circumstance

- The real phone number (E.164) of either phone involved
- The message text sent or the STOP keyword's exact original-language wording
- Either phone's JID (`@s.whatsapp.net` / `@lid` address)
- Any raw Baileys event payload dumped verbatim (a redacted, ids-only summary is fine; the raw JSON is not)

## Why this cannot be simulated

A hand-built fixture payload proves the code path handles the SHAPE we assumed Baileys emits. It cannot prove
that assumption is correct — `receiptEventTypeFromStatus`'s `proto.WebMessageInfo.Status` mapping (SERVER_ACK=2,
DELIVERY_ACK=3, READ=4, PLAYED=5), `message-receipt.update`'s exact `receipt.userJid`/`receiptTimestamp`/
`readTimestamp` field presence, and whether a real inbound STOP arrives as `messages.upsert` with `type:
'notify'` at all, are all facts about WhatsApp's real wire protocol that only a real linked session can confirm.
Writing a synthetic run up as this evidence would be exactly the kind of false evidence invariant 7 exists to
prevent.

## Results table (fill in only from a real trial)

| Item                                                       | Expected shape | Observed |
| ---------------------------------------------------------- | -------------- | -------- |
| `opt_outs.id`                                              |                |          |
| `opt_outs.phone_hash` (hex)                                |                |          |
| `message_jobs` cancelled (`cancel_reason='opt_out'`) count |                |          |
| `optout_confirmations` rows written                        |                |          |
| `delivery_events.provider_event_id` (delivered)            |                |          |
| `delivery_events.provider_event_id` (read)                 |                |          |
| `wp_receipts_total{event_type="delivered"}` delta          |                |          |
| `wp_receipts_total{event_type="read"}` delta               |                |          |
| `inbound_dead_letters` count (this client, trial window)   | 0              |          |

## Verdict

_(Fill in only after the results table above is complete: did the real STOP write exactly one `opt_outs` row and
cancel the expected jobs; did both receipts (delivered, read) land as exactly one `delivery_events` row each;
was the dead-letter count exactly 0.)_

## Operator runbook

All commands run from the repo root (`D:\kd\wp`). No new script is required — this trial drives the existing
panel + a real linked-device session already wired by this phase's own units.

### Stage 0 — link the second real phone

Use the panel's existing "Connect a number" flow to link a **second** real phone (never the founder's primary
number — same ban-risk discipline as `docs/evidence/P12-spike-2-echo.md`). Wait for the instance to reach
`connected`.

### Stage 1 — send one message from the linked number to the second phone

From the panel, send one text message from the linked (WP-controlled) number to the second phone. Wait for
WhatsApp's own delivered tick, then have the second phone open the chat (read tick).

### Stage 2 — reply STOP from the second phone

From the second phone, send a message containing the STOP keyword (any of the configured English/Hindi/Hinglish
keywords) back to the linked number.

### Stage 3 — collect the evidence

Run each query below **inside** `tenantDb.withTenant(clientId, ...)` for the linked number's own `client_id` —
never against a superuser pool, and never across tenants:

```sql
SELECT id, phone_hash FROM opt_outs WHERE client_id = $1;
SELECT count(*) FROM message_jobs WHERE client_id = $1 AND status = 'cancelled' AND cancel_reason = 'opt_out';
SELECT count(*) FROM optout_confirmations WHERE client_id = $1;
SELECT provider_event_id, event_type FROM delivery_events WHERE client_id = $1 ORDER BY created_at;
SELECT count(*) FROM inbound_dead_letters WHERE client_id = $1;
```

Read the `wp_receipts_total` and `wp_inbound_dead_letters_total` metric deltas from the worker's own `/metrics`
endpoint (before/after the trial). Paste every value above, hex-encoded where noted, into the results table, then
flip the STATUS line at the top of this document from "NOT YET RUN" to the completion date.

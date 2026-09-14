/**
 * Verbatim user-facing disclosure copy - single source of truth, used
 * identically in panel, docs and marketing. `scripts/check-copy.ts` (P00
 * step 9, not yet wired) requires each string to co-occur alongside any
 * surface string containing "Safe Mode" / "Broadcast" respectively.
 */

/**
 * Source: `.memory/research/2026-08-25-v1-architecture-blueprint.md` line
 * ~512 ("Safe Mode" section). Never claims Safe Mode prevents or guarantees
 * against WhatsApp restrictions (invariant 6).
 */
export const SAFE_MODE_DISCLAIMER =
  "Safe Mode paces your sending and watches your account's real signals. It reduces the risk of triggering spam or rate-limit signals from sending too fast or too cold. It cannot prevent or guarantee against WhatsApp restrictions — bans also come from recipient reports, message content and account reputation, which no sender-side pacing can control.";

/**
 * Source: `.memory/research/2026-08-26-v1r-scope-delta-and-decisions.md`
 * line 437 (markdown blockquote `> ` prefix and `**bold**` markers
 * stripped; text otherwise verbatim).
 */
// A template literal (not a single-quoted string) so this file's raw source
// text is byte-for-byte identical to the constant's runtime value - no `\'`
// escapes to break `scripts/check-copy.ts`'s plain substring match against
// the file text it reads from disk (see check-copy.ts's co-presence clause).
export const BROADCAST_DISCLOSURE = `What "Broadcast" means in WP. WhatsApp's own broadcast lists have a limitation most people discover the hard way: a broadcast-list message is only delivered to recipients who have already saved your number in their phone. Everyone else silently receives nothing. WP does not use broadcast lists. When you send a WP Broadcast, we create one individually-addressed message per recipient — the same thing as if you had opened each chat and typed it yourself — and we send them one at a time, paced, from your connected number. That is why a broadcast to 2,000 people takes hours or days rather than seconds: the pacing is the product. It also means each recipient sees a normal one-to-one message from you, can reply to it, and their reply lands in your Inbox. A Broadcast is not a licence to exceed your account's daily cap — it simply takes as long as your cap allows, and the panel shows you the honest estimated finish time before you start.`;

/**
 * Source: `.memory/research/2026-08-26-v1r-scope-delta-and-decisions.md`,
 * *How caps shape the ETA (and the pre-flight)* - verbatim. The per-recipient
 * frequency guard (`recipient_send_buckets`) is keyed per CLIENT, never per
 * number; this line ships on every pre-flight so the product never nudges a
 * customer toward hand-rolled number rotation (core invariant 6).
 */
export const BROADCAST_FREQUENCY_NOTE =
  'Sending the same audience from another number does not increase how often a person can be messaged — the frequency limit is per workspace.';

/** The pre-flight finish time is an estimate derived from the effective daily cap - never a delivery-speed promise (safety-compliance: honest claims). */
export const BROADCAST_ESTIMATE_CAVEAT = 'This is an estimate, not a guarantee.';

/**
 * Source: `.memory/research/2026-08-26-v1r-scope-delta-and-decisions.md`,
 * Groups section, "Required risk copy (product and ToS)" - verbatim; the
 * ONLY change from that source is the initial capital letter for standalone
 * display. Never paraphrase this string.
 */
// A template literal (not a single-quoted string), same reasoning as
// `BROADCAST_DISCLOSURE` above: this file's raw source text must be
// byte-for-byte identical to the constant's runtime value for
// `scripts/check-copy.ts`'s plain substring match.
export const GROUP_RISK_DISCLOSURE = `Sending promotional messages into WhatsApp groups is one of the highest report-rate behaviours on the platform. A single annoyed member can report the message, and group reports are visible to WhatsApp in a way one-to-one messages are not. WP caps group sending, disables it during warm-up, and switches it off first when your account's health signals worsen — but a group blast is riskier than the same message sent one-to-one, and no pacing changes that.`;

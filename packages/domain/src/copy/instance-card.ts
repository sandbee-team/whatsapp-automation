import { PARKED_COPY } from './instance-copy.js';

/**
 * copy/instance-card.ts (P17 Unit U2, step 2) - verbatim user-facing copy
 * for the instance card / health-why-drawer surfaces.
 *
 * `parked` REUSES `PARKED_COPY` from `instance-copy.ts` verbatim (never
 * restated - see that file's own header: ADR 0018 §1, em-dash exactly).
 * WhatsApp's server-side offline buffer is undocumented, so this string is
 * never softened into an implied guarantee (core invariant 6).
 *
 * `notSending` is shown in the countdown slot while paused/parked: the
 * countdown is a FLOOR (the earliest sending could resume), never an ETA -
 * this string states that explicitly rather than implying a promised
 * resume time.
 *
 * The two why-drawer honesty labels state the truth about v1's twelve
 * health signals plainly: `signalNotScored` for a signal that is collected
 * but not weighted into the score (see `app/backend`'s
 * `SCORED_SIGNAL_KEYS`), `signalNotEnoughData` for a signal below its
 * minimum-evidence gate - neither is phrased as a penalty.
 */
export const INSTANCE_CARD_COPY = {
  parked: PARKED_COPY,
  notSending:
    'Not sending right now. The time shown is the earliest sending could resume, not a ' +
    'guaranteed time — it depends on this number staying healthy and connected.',
  signalNotScored: 'Observed but not scored in v1 — shown for transparency, costing 0 points.',
  signalNotEnoughData: 'Not enough data yet — this is not a penalty.',
};

export type InstanceCardCopy = typeof INSTANCE_CARD_COPY;

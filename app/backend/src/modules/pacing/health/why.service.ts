import { HEALTH_SIGNAL_NAMES, INSTANCE_CARD_COPY, type HealthSignalName } from '@wp/domain';
import type { HealthSignalEntry, HealthWhyData } from '@wp/contracts';
import type { TenantDb } from '@wp/db';
import { SCORED_SIGNAL_KEYS } from './signals/registry.js';

/**
 * why.service.ts (P17 Unit U4, step 8) - `readHealthWhy`: the "why?" drawer's
 * read model. Reads `instance_pacing_state.last_evidence` (P16's
 * `ScoreEvidence` shape - `score.ts`'s own header) and projects EVERY
 * registered signal (`@wp/domain`'s `HEALTH_SIGNAL_NAMES`, in registry order)
 * into the contract's `HealthSignalEntry` shape - `scored: true` ONLY for
 * the registry's locked scored set `{hard_restriction, rejected_send_rate,
 * delivery_ratio}` (`SCORED_SIGNAL_KEYS`), every other signal `scored: false,
 * pointsCost: 0` with the honesty copy key - NEVER a fabricated points cost.
 *
 * A signal absent from `last_evidence` (a brand-new instance the evaluator
 * has never ticked) or explicitly `unmeasured: true` resolves to the SAME
 * not-enough-data shape as a real zero-evidence tick - never a penalty, and
 * never treated as "unhealthy by omission".
 */

const SCORED_ENTRY_WINDOW = 'evidence-weighted score';

interface StoredSignalEvidence {
  numerator: number | null;
  denominator: number | null;
  value: number | null;
  severity: number | null;
  weightApplied: number;
  unmeasured: boolean;
}

type StoredEvidence = Readonly<Record<string, StoredSignalEvidence | undefined>>;

function entryFor(
  signal: HealthSignalName,
  stored: StoredSignalEvidence | undefined,
): HealthSignalEntry {
  const scored = SCORED_SIGNAL_KEYS.has(signal);
  const unmeasured = !stored || stored.unmeasured;

  if (unmeasured) {
    return {
      signal,
      measuredValue: null,
      window: SCORED_ENTRY_WINDOW,
      evidenceCount: 0,
      scored,
      pointsCost: 0,
      exemptReason: scored ? null : INSTANCE_CARD_COPY.signalNotEnoughData,
    };
  }

  return {
    signal,
    measuredValue: stored.value,
    window: SCORED_ENTRY_WINDOW,
    evidenceCount: stored.denominator ?? 0,
    scored,
    // NEVER a fabricated cost for an unscored signal - `weightApplied` is
    // already 0 for every non-scored signal per score.ts's own contract, so
    // this is a straight passthrough, not a re-derivation.
    pointsCost: scored ? stored.weightApplied : 0,
    exemptReason: scored ? null : INSTANCE_CARD_COPY.signalNotScored,
  };
}

interface PacingStateEvidenceRow extends Record<string, unknown> {
  last_evidence: StoredEvidence;
}

interface PacingEventTimelineRow extends Record<string, unknown> {
  id: string;
  kind: string;
  created_at: Date;
}

export interface ReadHealthWhyInput {
  clientId: string;
  instanceId: string;
  timelineLimit?: number;
}

const DEFAULT_TIMELINE_LIMIT = 20;

export class HealthWhyNotFoundError extends Error {
  readonly code = 'NOT_FOUND';
  constructor() {
    super('No such WhatsApp instance.');
    this.name = 'HealthWhyNotFoundError';
  }
}

/** Reads the why-drawer's full twelve-signal breakdown plus the recent `pacing_events` timeline for one instance. */
export async function readHealthWhy(
  tenantDb: TenantDb,
  input: ReadHealthWhyInput,
): Promise<HealthWhyData> {
  const limit = input.timelineLimit ?? DEFAULT_TIMELINE_LIMIT;

  return tenantDb.withTenant(input.clientId, async (tx) => {
    const stateResult = await tx.query<PacingStateEvidenceRow>(
      `SELECT last_evidence FROM instance_pacing_state WHERE instance_id = $1 AND client_id = $2`,
      [input.instanceId, input.clientId],
    );
    const stateRow = stateResult.rows[0];
    if (!stateRow) {
      throw new HealthWhyNotFoundError();
    }

    const storedEvidence = stateRow.last_evidence ?? {};
    const signals = HEALTH_SIGNAL_NAMES.map((signal) => entryFor(signal, storedEvidence[signal]));

    const timelineResult = await tx.query<PacingEventTimelineRow>(
      `SELECT id, kind, created_at FROM pacing_events
        WHERE client_id = $1 AND instance_id = $2
        ORDER BY created_at DESC
        LIMIT $3`,
      [input.clientId, input.instanceId, limit],
    );
    const timeline = timelineResult.rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      createdAt: row.created_at.toISOString(),
    }));

    return { signals, timeline };
  });
}

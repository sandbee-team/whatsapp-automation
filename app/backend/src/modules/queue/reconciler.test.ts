import '../realtime/__test-support__/stub-wp-server-kit-env.js';
import { describe, expect, it } from 'vitest';
import { computeContentHash } from '../../engine/queue/content-hash.js';
import {
  decideReconciliation,
  type ReconcileCandidate,
  type UnresolvedEvidenceRow,
} from './reconciler-decision.js';

/**
 * reconciler.test.ts (P12 Unit U3, step 6) - unit-tests the PURE decision
 * core (`reconciler-decision.ts#decideReconciliation`) against fabricated
 * candidates/evidence, no real Postgres. This repo has no in-memory DB fake,
 * so the DB-driving wrapper (`reconciler.ts`) and its actual writes are
 * proved by `reconciler.integration.test.ts` instead - this file proves the
 * DECISION table alone.
 */

const RECONCILE_WINDOW_MS = 600_000;
const NOW_MS = Date.parse('2026-09-01T12:00:00.000Z');

function baseCandidate(overrides: Partial<ReconcileCandidate> = {}): ReconcileCandidate {
  return {
    clientId: 'client-1',
    instanceId: 'instance-1',
    contentHash: computeContentHash({ jid: '1@s.whatsapp.net', kind: 'text', text: 'hello' }),
    dispatchedAt: new Date(NOW_MS - 60_000),
    siblingInflightCount: 0,
    ...overrides,
  };
}

describe('decideReconciliation', () => {
  it('echo_reconciles_ambiguous_hashes_conservatively', () => {
    // Mandatory suite test 17: two in-flight attempts share the same content
    // hash (siblingInflightCount > 0) - neither is resolved, both go to
    // ambiguous (caller maps this to blocked_needs_review + the metric).
    const candidate = baseCandidate({ siblingInflightCount: 1 });
    const evidenceRows: UnresolvedEvidenceRow[] = [
      { waMsgId: 'wamid-1', observedAt: new Date(NOW_MS - 30_000) },
    ];

    const outcome = decideReconciliation({
      candidate,
      evidenceRows,
      nowMs: NOW_MS,
      reconcileWindowMs: RECONCILE_WINDOW_MS,
    });

    expect(outcome).toEqual({ kind: 'ambiguous' });
  });

  it('more_than_one_matching_evidence_row_is_also_ambiguous', () => {
    const candidate = baseCandidate({ siblingInflightCount: 0 });
    const evidenceRows: UnresolvedEvidenceRow[] = [
      { waMsgId: 'wamid-1', observedAt: new Date(NOW_MS - 30_000) },
      { waMsgId: 'wamid-2', observedAt: new Date(NOW_MS - 20_000) },
    ];

    const outcome = decideReconciliation({
      candidate,
      evidenceRows,
      nowMs: NOW_MS,
      reconcileWindowMs: RECONCILE_WINDOW_MS,
    });

    expect(outcome).toEqual({ kind: 'ambiguous' });
  });

  it('a_single_unambiguous_evidence_row_resolves_the_candidate', () => {
    const candidate = baseCandidate();
    const observedAt = new Date(NOW_MS - 30_000);
    const evidenceRows: UnresolvedEvidenceRow[] = [{ waMsgId: 'wamid-1', observedAt }];

    const outcome = decideReconciliation({
      candidate,
      evidenceRows,
      nowMs: NOW_MS,
      reconcileWindowMs: RECONCILE_WINDOW_MS,
    });

    expect(outcome).toEqual({
      kind: 'resolve',
      evidenceWaMsgId: 'wamid-1',
      evidenceObservedAt: observedAt,
    });
  });

  it('an_echo_outside_the_five_minute_tolerance_is_not_a_match', () => {
    // The caller's SQL/lookup is responsible for pre-filtering evidence rows
    // to the tolerance window (TIMING.echoToleranceMs) before calling this
    // function - stale evidence outside tolerance is simply never passed in,
    // so an empty evidenceRows array with a still-open window waits rather
    // than falsely resolving.
    const candidate = baseCandidate({ dispatchedAt: new Date(NOW_MS - 60_000) });

    const outcome = decideReconciliation({
      candidate,
      evidenceRows: [],
      nowMs: NOW_MS,
      reconcileWindowMs: RECONCILE_WINDOW_MS,
    });

    expect(outcome).toEqual({ kind: 'wait' });
  });

  it('window_expiry_with_no_evidence_is_expired_never_a_silent_match', () => {
    const candidate = baseCandidate({
      dispatchedAt: new Date(NOW_MS - RECONCILE_WINDOW_MS - 1),
    });

    const outcome = decideReconciliation({
      candidate,
      evidenceRows: [],
      nowMs: NOW_MS,
      reconcileWindowMs: RECONCILE_WINDOW_MS,
    });

    expect(outcome).toEqual({ kind: 'expired' });
  });

  it('exactly_at_the_window_boundary_is_expired_not_wait', () => {
    const candidate = baseCandidate({
      dispatchedAt: new Date(NOW_MS - RECONCILE_WINDOW_MS),
    });

    const outcome = decideReconciliation({
      candidate,
      evidenceRows: [],
      nowMs: NOW_MS,
      reconcileWindowMs: RECONCILE_WINDOW_MS,
    });

    expect(outcome).toEqual({ kind: 'expired' });
  });

  it('captionless_media_ambiguity_manifests_as_a_shared_content_hash', () => {
    // ADR 0035 §5: a captionless media message hashes to (jid, 'media', '') -
    // not per-message-unique. Two captionless media sends to the same
    // recipient inside the window are indistinguishable at the hash level,
    // which surfaces here as siblingInflightCount > 0 (or >1 evidence row) -
    // exactly the same ambiguous path as test 17, not a special case.
    const captionlessHash = computeContentHash({
      jid: '1@s.whatsapp.net',
      kind: 'media',
      text: '',
    });
    const candidate = baseCandidate({ contentHash: captionlessHash, siblingInflightCount: 1 });

    const outcome = decideReconciliation({
      candidate,
      evidenceRows: [{ waMsgId: 'wamid-1', observedAt: new Date(NOW_MS - 10_000) }],
      nowMs: NOW_MS,
      reconcileWindowMs: RECONCILE_WINDOW_MS,
    });

    expect(outcome).toEqual({ kind: 'ambiguous' });
  });

  it('an_lid_addressed_echo_produces_no_evidence_and_eventually_expires', () => {
    // ADR 0035 §2: normalizeWaJidForHash leaves @lid UNCHANGED (no LID->PN
    // resolution in the pure module), so a dispatch-side hash computed from
    // the stored E.164-derived JID never equals an echo hashed from a raw
    // @lid JID. The reconciler sees this as ordinary "no evidence found" -
    // it never receives a candidate evidence row for the mismatched hash -
    // and a window-expired candidate with zero evidence rows fails safe to
    // 'expired', never a guessed match.
    const candidate = baseCandidate({
      dispatchedAt: new Date(NOW_MS - RECONCILE_WINDOW_MS - 1),
    });

    const outcome = decideReconciliation({
      candidate,
      evidenceRows: [], // the @lid echo hashed to a DIFFERENT content_hash, so it never appears here
      nowMs: NOW_MS,
      reconcileWindowMs: RECONCILE_WINDOW_MS,
    });

    expect(outcome).toEqual({ kind: 'expired' });
  });
});

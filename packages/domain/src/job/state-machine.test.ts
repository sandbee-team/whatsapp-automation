import { describe, expect, it } from 'vitest';
import {
  canTransition,
  JOB_TRANSITIONS,
  TERMINAL_JOB_STATES,
  type JobStatus,
} from './state-machine.js';

// The canonical `job_status` enum [R-31] (architecture blueprint, "Canonical
// enums" section) - hardcoded here (not derived from the implementation)
// so this test actually proves canTransition matches the declared edge
// list, rather than trivially agreeing with itself.
const ALL_STATES: JobStatus[] = [
  'created',
  'queued',
  'processing',
  'sent',
  'failed',
  'cancelled',
  'needs_reconcile',
  'blocked_needs_review',
];

describe('job status FSM', () => {
  it('job_fsm_rejects_every_undeclared_transition', () => {
    const declared = new Set<string>();
    for (const from of ALL_STATES) {
      for (const to of JOB_TRANSITIONS[from]) {
        declared.add(`${from}->${to}`);
      }
    }

    for (const from of ALL_STATES) {
      for (const to of ALL_STATES) {
        const key = `${from}->${to}`;
        expect(canTransition(from, to)).toBe(declared.has(key));
      }
    }
  });

  it('a_terminal_job_never_transitions_again', () => {
    expect(TERMINAL_JOB_STATES.length).toBeGreaterThan(0);
    for (const terminal of TERMINAL_JOB_STATES) {
      expect(JOB_TRANSITIONS[terminal]).toEqual([]);
      for (const to of ALL_STATES) {
        expect(canTransition(terminal, to)).toBe(false);
      }
    }
  });

  it('every_reflexive_transition_state_to_itself_is_rejected', () => {
    for (const state of ALL_STATES) {
      expect(canTransition(state, state)).toBe(false);
    }
  });

  it('every_terminal_x_terminal_pair_is_rejected_including_self', () => {
    for (const from of TERMINAL_JOB_STATES) {
      for (const to of TERMINAL_JOB_STATES) {
        expect(canTransition(from, to)).toBe(false);
      }
    }
  });

  it('a_garbage_status_not_in_the_declared_enum_never_transitions_anywhere_at_the_js_surface', () => {
    // canTransition is compile-time-typed to JobStatus, but the guarded JS
    // surface (e.g. a value read from an untyped JSON payload or the DB) can
    // still hand it garbage at runtime - `JOB_TRANSITIONS[from]` is then
    // `undefined`, and `.includes` on undefined must not silently succeed or
    // throw uncontrolled; it must throw, so a caller cannot mistake a bug for
    // "no transition allowed".
    const garbage = 'totally_unknown_status' as unknown as JobStatus;
    expect(() => canTransition(garbage, 'queued')).toThrow();
  });
});

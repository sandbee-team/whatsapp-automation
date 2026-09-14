import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { PgLoadArtifact } from './pg-load.js';
import { validatePgLoadArtifact } from './pg-load-validate.js';

/**
 * pg-load-validate.test.ts (P26 Unit U4, step 4) - `validatePgLoadArtifact`
 * edge cases plus the derived-literal isolation scan, split out of
 * `pg-load.test.ts` for the 300-line cap.
 */

describe('validatePgLoadArtifact edge cases', () => {
  it('rejects a non-object input', () => {
    expect(validatePgLoadArtifact(null).ok).toBe(false);
    expect(validatePgLoadArtifact('nope').ok).toBe(false);
  });

  it('rejects window.seconds <= 0', () => {
    const artifact: Partial<PgLoadArtifact> = {
      sends: { attempted: 10, observed: 10 },
      window: { startMs: 0, endMs: 0, seconds: 0 },
      deltas: {
        statements: 10,
        relationSizeBytes: 100,
        walBytes: 10,
        perTableBytes: {},
        baselineSubtracted: null,
      },
      derivedComparison: {
        statementsPerSendDerived: 12,
        bytesPerSendDerived: 3276.8,
        sendsPerDayDerived: 600,
        agreement: 'x',
      },
      viaPgBouncer: true,
      baseline: null,
      notes: ['--baseline-seconds 0 was explicitly passed - no idle baseline was sampled'],
    };
    const { ok, problems } = validatePgLoadArtifact(artifact);
    expect(ok).toBe(false);
    expect(problems.some((p) => p.includes('window.seconds'))).toBe(true);
  });

  it('rejects an empty derivedComparison.agreement', () => {
    const artifact: Partial<PgLoadArtifact> = {
      sends: { attempted: 10, observed: 10 },
      window: { startMs: 0, endMs: 1000, seconds: 1 },
      deltas: {
        statements: 10,
        relationSizeBytes: 100,
        walBytes: 10,
        perTableBytes: {},
        baselineSubtracted: null,
      },
      derivedComparison: {
        statementsPerSendDerived: 12,
        bytesPerSendDerived: 3276.8,
        sendsPerDayDerived: 600,
        agreement: '   ',
      },
      viaPgBouncer: true,
      baseline: null,
      notes: ['--baseline-seconds 0 was explicitly passed - no idle baseline was sampled'],
    };
    const { ok, problems } = validatePgLoadArtifact(artifact);
    expect(ok).toBe(false);
    expect(problems.some((p) => p.includes('agreement'))).toBe(true);
  });

  it('rejects a missing jobStatusHistogram (Harness gap fix)', () => {
    const artifact: Partial<PgLoadArtifact> = {
      sends: { attempted: 10, observed: 10 },
      window: { startMs: 0, endMs: 1000, seconds: 1 },
      deltas: {
        statements: 10,
        relationSizeBytes: 100,
        walBytes: 10,
        perTableBytes: {},
        baselineSubtracted: null,
      },
      derivedComparison: {
        statementsPerSendDerived: 12,
        bytesPerSendDerived: 3276.8,
        sendsPerDayDerived: 600,
        agreement: 'x',
      },
      viaPgBouncer: true,
      baseline: null,
      notes: ['--baseline-seconds 0 was explicitly passed - no idle baseline was sampled'],
    };
    const { ok, problems } = validatePgLoadArtifact(artifact);
    expect(ok).toBe(false);
    expect(problems.some((p) => p.includes('jobStatusHistogram'))).toBe(true);

    const withHistogram = { ...artifact, jobStatusHistogram: { queued: 3, sent: 7 } };
    expect(validatePgLoadArtifact(withHistogram).ok).toBe(true);
  });

  it('rejects drain.complete === false as evidence of a failed run (FIX-P26-E)', () => {
    const artifact: Partial<PgLoadArtifact> = {
      sends: { attempted: 10, observed: 10 },
      window: { startMs: 0, endMs: 1000, seconds: 1 },
      deltas: {
        statements: 10,
        relationSizeBytes: 100,
        walBytes: 10,
        perTableBytes: {},
        baselineSubtracted: null,
      },
      derivedComparison: {
        statementsPerSendDerived: 12,
        bytesPerSendDerived: 3276.8,
        sendsPerDayDerived: 600,
        agreement: 'x',
      },
      viaPgBouncer: true,
      baseline: null,
      jobStatusHistogram: { processing: 3 },
      notes: ['--baseline-seconds 0 was explicitly passed - no idle baseline was sampled'],
      drain: { complete: false, pendingAtEnd: 3, pendingSample: [] },
    };
    const { ok, problems } = validatePgLoadArtifact(artifact);
    expect(ok).toBe(false);
    expect(problems).toContain(
      'drain incomplete: 3 jobs still pending at the deadline - this artifact is evidence of a failed run, not a publishable load model',
    );
  });

  it('rejects drain.complete === true with pendingAtEnd > 0 as a contradiction (FIX-P26-E)', () => {
    const artifact: Partial<PgLoadArtifact> = {
      sends: { attempted: 10, observed: 10 },
      window: { startMs: 0, endMs: 1000, seconds: 1 },
      deltas: {
        statements: 10,
        relationSizeBytes: 100,
        walBytes: 10,
        perTableBytes: {},
        baselineSubtracted: null,
      },
      derivedComparison: {
        statementsPerSendDerived: 12,
        bytesPerSendDerived: 3276.8,
        sendsPerDayDerived: 600,
        agreement: 'x',
      },
      viaPgBouncer: true,
      baseline: null,
      jobStatusHistogram: { processing: 3 },
      notes: ['--baseline-seconds 0 was explicitly passed - no idle baseline was sampled'],
      drain: { complete: true, pendingAtEnd: 3, pendingSample: [] },
    };
    const { ok, problems } = validatePgLoadArtifact(artifact);
    expect(ok).toBe(false);
    expect(problems).toContain(
      'drain.complete is true but pendingAtEnd is 3 (must be 0) - contradiction',
    );
  });
});

describe('derived literals stay isolated to derivedComparison', () => {
  it('derived_literals_never_leak_outside_derived_comparison', () => {
    const here = fileURLToPath(new URL('./pg-load.ts', import.meta.url));
    const source = readFileSync(here, 'utf8');

    // Strip block comments and line comments so prose mentions of the ADR
    // figures (expected in the header) never fool the scan.
    const withoutComments = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');

    // Isolate every `derivedComparison: { ... }` block (bounded by its own
    // matching braces - there are two: the interface's type shape and the
    // builder's actual object literal) and remove each - whatever's LEFT
    // must not contain the ADR figures.
    let remaining = withoutComments;
    let blocksRemoved = 0;
    let searchFrom = 0;
    for (;;) {
      const startIdx = remaining.indexOf('derivedComparison: {', searchFrom);
      if (startIdx === -1) break;
      let depth = 0;
      let endIdx = startIdx;
      for (let i = remaining.indexOf('{', startIdx); i < remaining.length; i += 1) {
        const ch = remaining[i];
        if (ch === '{') depth += 1;
        if (ch === '}') {
          depth -= 1;
          if (depth === 0) {
            endIdx = i + 1;
            break;
          }
        }
      }
      remaining = remaining.slice(0, startIdx) + remaining.slice(endIdx);
      blocksRemoved += 1;
      searchFrom = startIdx;
    }
    expect(blocksRemoved).toBe(2);
    const withoutDerivedComparisonBlock = remaining;

    expect(withoutDerivedComparisonBlock).not.toMatch(/\b12\b/);
    expect(withoutDerivedComparisonBlock).not.toMatch(/\b600\b/);
    expect(withoutDerivedComparisonBlock).not.toMatch(/3\.2\b/);
    expect(withoutDerivedComparisonBlock).not.toMatch(/3276\.8\b/);
  });
});

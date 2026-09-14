import type { GuardViolation } from './scan-config.js';

/**
 * capacity-gate-b-lib.ts (P26 Unit U8, step 8) - Gate B's pure clauses,
 * split out of `check-capacity-gate.ts` to keep that file under the
 * `max-lines: 300` cap (same idiom as `alert-rules-lib.ts`). No filesystem
 * access here - `check-capacity-gate.ts` reads the doc(s) and passes already
 * -read text in.
 *
 * (d) `scanFleetCapacityDoc`: the Gate B fleet-capacity doc must carry
 *     either the pending banner (verbatim) or a closed-banner line, plus
 *     Measured N / run duration / error-bar markers - each accepting a
 *     `<FILL ...>` placeholder so the skeleton passes and a stripped doc
 *     fails red (same idiom as `check-capacity-gate.ts`'s sample-size
 *     marker).
 * (e) `scanTenThousandClaims`: a bare "10,000"/"10k" capacity claim in any
 *     capacity doc requires the ADR 0018 §8 honest sentence ("has been
 *     measured to N") somewhere in the same file, or every matching line is
 *     a violation.
 */

/**
 * Gate B (P26 Unit U8) - the fleet-capacity publication skeleton. P26a fills
 * in the real numbers and flips the banner; this doc must pass the gate WITH
 * placeholders (`<FILL ...>`) and fail it when a marker is stripped.
 */
export const FLEET_CAPACITY_DOC_PATH = 'docs/capacity/fleet-capacity.md';

/** Verbatim, em dash - the Gate B pending banner (P26a flips this at close). */
export const GATE_B_PENDING_BANNER = 'DRIFT VERDICT PENDING — P26a';

/** P26a flips the pending banner to this prefix + the measured N. */
export const GATE_B_CLOSED_BANNER_PREFIX = 'GATE B CLOSED — measured to N=';

/** Every capacity doc under this glob is subject to the 10k-claim scan (clause e). */
export const CAPACITY_DOC_GLOBS = ['docs/capacity/*.md'];

/** A bare "10,000"/"10.000"/"10k" (case-insensitive) capacity claim. */
export const TEN_THOUSAND_CLAIM_PATTERN = /\b10[,.]?000\b|\b10k\b/i;

/** ADR 0018 §8's honest sentence marker (case-insensitive substring match). */
export const MEASURED_TO_N_SENTENCE = 'has been measured to';

export interface SourceFile {
  path: string;
  content: string;
}

/** Loose Measured N marker: accepts a real number or a `<FILL ...>` placeholder (optionally backtick-quoted). */
const MEASURED_N_PATTERN = /\bMeasured N\s*[=:]\s*`?(?:\d[\d,]*|<FILL[^>]*>)/i;

/** Loose run-duration marker: any non-whitespace value or a `<FILL ...>` placeholder (optionally backtick-quoted). */
const RUN_DURATION_PATTERN = /\bRun duration\s*[=:]\s*`?(?:\S+|<FILL[^>]*>)/i;

/** Loose error-bar marker: a "95% CI" mention or a bare ± sign. */
const ERROR_BAR_PATTERN = /95% CI|±/;

/** Clause (d): see file header. */
export function scanFleetCapacityDoc(docPath: string, content: string): GuardViolation[] {
  const violations: GuardViolation[] = [];

  const hasPendingBanner = content.includes(GATE_B_PENDING_BANNER);
  const hasClosedBanner = content
    .split('\n')
    .some((line) => /^GATE B CLOSED — measured to N=\d/.test(line.trim()));
  if (!hasPendingBanner && !hasClosedBanner) {
    violations.push({
      file: docPath,
      message: `capacity gate: banner missing or stripped - the fleet-capacity doc must carry either "${GATE_B_PENDING_BANNER}" verbatim or a "${GATE_B_CLOSED_BANNER_PREFIX}<n>" line`,
    });
  }

  if (!MEASURED_N_PATTERN.test(content)) {
    violations.push({
      file: docPath,
      message:
        'capacity gate: Measured N marker missing - the fleet-capacity doc must state Measured N, even as a placeholder',
    });
  }

  if (!RUN_DURATION_PATTERN.test(content)) {
    violations.push({
      file: docPath,
      message:
        'capacity gate: Run duration marker missing - the fleet-capacity doc must state Run duration, even as a placeholder',
    });
  }

  if (!ERROR_BAR_PATTERN.test(content)) {
    violations.push({
      file: docPath,
      message:
        'capacity gate: error bar marker missing - the fleet-capacity doc must state a 95% CI or ± error bar, even as a placeholder',
    });
  }

  return violations;
}

/** Clause (e): see file header. */
export function scanTenThousandClaims(files: SourceFile[]): GuardViolation[] {
  const violations: GuardViolation[] = [];
  for (const file of files) {
    const hasSentence = file.content.toLowerCase().includes(MEASURED_TO_N_SENTENCE.toLowerCase());
    if (hasSentence) continue;

    const lines = file.content.split('\n');
    lines.forEach((line, index) => {
      if (TEN_THOUSAND_CLAIM_PATTERN.test(line)) {
        violations.push({
          file: file.path,
          line: index + 1,
          message:
            'capacity gate: a 10,000/10k capacity claim without the ADR 0018 §8 honest sentence ("the architecture has no known ceiling below 10,000 and has been measured to N") - Gate C is not closed',
        });
      }
    });
  }
  return violations;
}

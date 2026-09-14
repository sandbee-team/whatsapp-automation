import { TEN_THOUSAND_CLAIM_PATTERN } from './capacity-gate-b-lib.js';
import type { GuardViolation } from './scan-config.js';

/**
 * copy-public-capacity-lib.ts (P29 step 1, Unit U1) - clause (e) of the copy
 * guard: a derived capacity/cost figure quoted on a PUBLIC surface (the
 * marketing website) is only ever permitted as the exact ADR 0018 §8
 * honest sentence built from the LIVE Gate C `Measured N`
 * (`docs/capacity/fleet-capacity.md`) - never a hardcoded number, and never
 * a session-count/dollar/latency/box-sizing figure quoted standalone. Pure -
 * no filesystem access; the caller (`check-copy.ts`) reads
 * `fleet-capacity.md` and passes its parsed `measuredN` in.
 */

/** A file is a "public surface" iff its repo-relative posix path starts with one of these. */
export const PUBLIC_SURFACE_PREFIXES: readonly string[] = ['website/'];

/** ADR 0018 §8's honest sentence prefix; the only permitted capacity claim on a public surface. */
export const GATE_C_SENTENCE_PREFIX =
  'the architecture has no known ceiling below 10,000 concurrent connected numbers and has been measured to ';

/** Builds the one permitted capacity sentence for a given Measured N (e.g. "1,000"). */
export function gateCSentence(measuredN: string): string {
  return `${GATE_C_SENTENCE_PREFIX}${measuredN}`;
}

/** Reads `Measured N = <n>` (first match) out of the fleet-capacity doc's already-read text. */
export function readMeasuredN(fleetCapacityDocText: string): string | undefined {
  const match = /\bMeasured N\s*=\s*([\d,]+)/.exec(fleetCapacityDocText);
  return match?.[1];
}

/**
 * A line on a public surface offends if it matches ANY of these. Every
 * pattern targets a DERIVED capacity/cost figure - a number engineering
 * measured or costed, never a plain product description.
 */
export const PUBLIC_CAPACITY_COST_PATTERNS: readonly RegExp[] = [
  // "10,000", "10.000", "10k" - the bare capacity claim itself.
  TEN_THOUSAND_CLAIM_PATTERN,
  // "2,000 sessions", "5,000 accounts" - a thousands-grouped session/account count.
  /\b\d{1,3}(?:[,.]\d{3})+\s*(?:concurrent\s+)?(?:sessions?|numbers?|connected|instances?|accounts?|sockets?)\b/i,
  // "2000 concurrent numbers" - a bare 4+-digit session/account count.
  /\b\d{4,}\s*(?:concurrent\s+)?(?:sessions?|numbers?|connected|instances?|accounts?|sockets?)\b/i,
  // "$0.28/number", "$0.23 per connected", "$0.23-$0.43" - a derived per-unit cost.
  /\$\s?\d+(?:\.\d+)?\s*(?:\/|per\b|-\s?\$?\d)/i,
  // "18 MB", "467.7 MiB" - a measured memory figure.
  /\b\d+(?:\.\d+)?\s*(?:MB|MiB|GB|GiB)\b/,
  // "600 sends/day" - a derived throughput figure.
  /\b\d+(?:[,.]\d+)?\s*(?:sends|messages)\s*(?:\/|per\s)\s*(?:day|hour|min|minute|s|sec|second)\b/i,
  // "p99" - a latency percentile.
  /\bp99\b/i,
  // "8 vCPU", "3 boxes" - box/CPU sizing.
  /\b\d+\s*(?:vCPU|boxes)\b/i,
];

/** Clause (e): see file header. */
export function scanPublicCapacityClaims(
  file: { path: string; content: string },
  measuredN: string | undefined,
): GuardViolation[] {
  if (!PUBLIC_SURFACE_PREFIXES.some((prefix) => file.path.startsWith(prefix))) {
    return [];
  }

  const permittedSentence = gateCSentence(measuredN ?? 'N');
  const violations: GuardViolation[] = [];
  const lines = file.content.split('\n');
  lines.forEach((line, index) => {
    if (measuredN !== undefined && line.includes(gateCSentence(measuredN))) {
      return;
    }
    for (const pattern of PUBLIC_CAPACITY_COST_PATTERNS) {
      const match = pattern.exec(line);
      if (match) {
        violations.push({
          file: file.path,
          line: index + 1,
          message: `public surface quotes a derived capacity/cost figure ("${match[0]}") - Gate C is not closed; the only permitted capacity sentence is "${permittedSentence}" (ADR 0016, ADR 0018 §8)`,
        });
        break;
      }
    }
  });
  return violations;
}

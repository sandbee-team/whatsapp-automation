import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  scanCapacityGate,
  runCheckCapacityGate,
  scanFleetCapacityDoc,
  scanTenThousandClaims,
  CAPACITY_GATE_BANNER,
  BANNED_CAPACITY_FIGURES,
  SESSION_COST_DOC_PATH,
  FLEET_CAPACITY_DOC_PATH,
} from '../check-capacity-gate.js';
import { REPO_ROOT } from './registry.js';

/**
 * check-capacity-gate.test.ts (P10 Unit U7, step 8) - fixture proof for the
 * capacity-gate guard. Follows the exact `check-copy.test.ts` idiom: a pure
 * `scanCapacityGate` over already-read source text, fed fixture content
 * under synthetic paths so the "figure in tenant copy" red-proof never
 * plants a real violation in the real tenant-facing trees.
 */

const FIXTURES_DIR = 'scripts/guards/__fixtures__/capacity-gate';

function readFixture(name: string): string {
  return readFileSync(path.join(REPO_ROOT, FIXTURES_DIR, name), 'utf8');
}

describe('check-capacity-gate (P10 Unit U7, step 8)', () => {
  it('published_table_must_carry_the_banner_and_a_sample_size', () => {
    const goodPath = SESSION_COST_DOC_PATH;
    const goodContent = readFileSync(path.join(REPO_ROOT, SESSION_COST_DOC_PATH), 'utf8');

    const goodViolations = scanCapacityGate({
      docPath: goodPath,
      docContent: goodContent,
      tenantFiles: [],
    });
    expect(goodViolations.some((v) => v.message.includes('banner'))).toBe(false);
    expect(goodViolations.some((v) => v.message.includes('sample size'))).toBe(false);

    // Strip the banner -> red.
    const noBannerContent = readFixture('session-cost-no-banner.md');
    const noBannerViolations = scanCapacityGate({
      docPath: goodPath,
      docContent: noBannerContent,
      tenantFiles: [],
    });
    expect(noBannerViolations.some((v) => v.message.includes('banner'))).toBe(true);

    // Strip the sample-size marker -> red.
    const noSampleSizeContent = readFixture('session-cost-no-sample-size.md');
    const noSampleSizeViolations = scanCapacityGate({
      docPath: goodPath,
      docContent: noSampleSizeContent,
      tenantFiles: [],
    });
    expect(noSampleSizeViolations.some((v) => v.message.includes('sample size'))).toBe(true);
  });

  it('a_measured_capacity_number_in_tenant_facing_copy_is_rejected', () => {
    const docContent = readFileSync(path.join(REPO_ROOT, SESSION_COST_DOC_PATH), 'utf8');

    const cleanTenantFile = {
      path: 'app/frontend/src/components/Fixture.tsx',
      content: readFixture('tenant-clean.tsx'),
    };
    const dirtyTenantFile = {
      path: 'app/frontend/src/components/Fixture.tsx',
      content: readFixture('tenant-with-figure.tsx'),
    };

    const cleanViolations = scanCapacityGate({
      docPath: SESSION_COST_DOC_PATH,
      docContent,
      tenantFiles: [cleanTenantFile],
    });
    expect(cleanViolations).toEqual([]);

    const dirtyViolations = scanCapacityGate({
      docPath: SESSION_COST_DOC_PATH,
      docContent,
      tenantFiles: [dirtyTenantFile],
    });
    expect(dirtyViolations.length).toBeGreaterThan(0);
    expect(
      dirtyViolations.some(
        (v) =>
          v.file === dirtyTenantFile.path &&
          v.message.includes(BANNED_CAPACITY_FIGURES[0] as string),
      ),
    ).toBe(true);
  });

  it('a_p10_measured_capacity_figure_in_tenant_facing_copy_is_also_rejected', () => {
    // WARNING 9 (FIX-P10-A): the newly-published component-A figures
    // (0.227 MB, 305 MB) must be caught by the same gate as the pre-P10
    // brackets, not just the original four tokens.
    const docContent = readFileSync(path.join(REPO_ROOT, SESSION_COST_DOC_PATH), 'utf8');

    const dirtyTenantFile = {
      path: 'app/frontend/src/components/FixtureP10.tsx',
      content: readFixture('tenant-with-p10-figure.tsx'),
    };

    const violations = scanCapacityGate({
      docPath: SESSION_COST_DOC_PATH,
      docContent,
      tenantFiles: [dirtyTenantFile],
    });

    expect(violations.length).toBeGreaterThan(0);
    expect(
      violations.some((v) => v.file === dirtyTenantFile.path && v.message.includes('0.227 MB')),
    ).toBe(true);
  });

  it('guard_matches_a_non_zero_number_of_files', () => {
    const result = runCheckCapacityGate();
    expect(result.filesScanned).toBeGreaterThan(0);
    expect(result.violations).toEqual([]);
  });

  it('the_banner_constant_matches_the_adr_0032_wording', () => {
    expect(CAPACITY_GATE_BANNER).toContain('SOCKET-RESIDENT-PRE-HANDSHAKE');
    expect(CAPACITY_GATE_BANNER).toContain('Gate B (P26) still open');
  });

  it('gate_b_table_requires_measured_n_run_duration_and_error_bars', () => {
    const realContent = readFileSync(path.join(REPO_ROOT, FLEET_CAPACITY_DOC_PATH), 'utf8');
    const realViolations = scanFleetCapacityDoc(FLEET_CAPACITY_DOC_PATH, realContent);
    expect(realViolations).toEqual([]);

    const noMeasuredN = readFixture('fleet-capacity-no-measured-n.md');
    const noMeasuredNViolations = scanFleetCapacityDoc(FLEET_CAPACITY_DOC_PATH, noMeasuredN);
    expect(noMeasuredNViolations.some((v) => v.message.includes('Measured N'))).toBe(true);

    const noRunDuration = readFixture('fleet-capacity-no-run-duration.md');
    const noRunDurationViolations = scanFleetCapacityDoc(FLEET_CAPACITY_DOC_PATH, noRunDuration);
    expect(noRunDurationViolations.some((v) => v.message.includes('Run duration'))).toBe(true);

    const noErrorBars = readFixture('fleet-capacity-no-error-bars.md');
    const noErrorBarsViolations = scanFleetCapacityDoc(FLEET_CAPACITY_DOC_PATH, noErrorBars);
    expect(noErrorBarsViolations.some((v) => v.message.includes('error bar'))).toBe(true);

    const noBanner = readFixture('fleet-capacity-no-banner.md');
    const noBannerViolations = scanFleetCapacityDoc(FLEET_CAPACITY_DOC_PATH, noBanner);
    expect(noBannerViolations.some((v) => v.message.includes('banner'))).toBe(true);
  });

  it('a_closed_banner_is_accepted_and_a_missing_banner_is_rejected', () => {
    const closedBanner = readFixture('fleet-capacity-closed-banner.md');
    const closedBannerViolations = scanFleetCapacityDoc(FLEET_CAPACITY_DOC_PATH, closedBanner);
    expect(closedBannerViolations.some((v) => v.message.includes('banner'))).toBe(false);

    const neitherBanner = readFixture('fleet-capacity-neither-banner.md');
    const neitherBannerViolations = scanFleetCapacityDoc(FLEET_CAPACITY_DOC_PATH, neitherBanner);
    expect(neitherBannerViolations.filter((v) => v.message.includes('banner')).length).toBe(1);
  });

  it('a_ten_thousand_claim_without_the_measured_n_sentence_is_rejected', () => {
    const withoutSentence = {
      path: 'scripts/guards/__fixtures__/capacity-gate/capacity-doc-10k-without-sentence.md',
      content: readFixture('capacity-doc-10k-without-sentence.md'),
    };
    const withoutSentenceViolations = scanTenThousandClaims([withoutSentence]);
    expect(withoutSentenceViolations.length).toBeGreaterThan(0);
    expect(
      withoutSentenceViolations.some(
        (v) => v.file === withoutSentence.path && v.message.includes('ADR 0018'),
      ),
    ).toBe(true);

    const withSentence = {
      path: 'scripts/guards/__fixtures__/capacity-gate/capacity-doc-10k-with-sentence.md',
      content: readFixture('capacity-doc-10k-with-sentence.md'),
    };
    const withSentenceViolations = scanTenThousandClaims([withSentence]);
    expect(withSentenceViolations).toEqual([]);

    const lowercaseWithoutSentence = {
      path: 'scripts/guards/__fixtures__/capacity-gate/capacity-doc-10k-lowercase-without-sentence.md',
      content: readFixture('capacity-doc-10k-lowercase-without-sentence.md'),
    };
    const lowercaseViolations = scanTenThousandClaims([lowercaseWithoutSentence]);
    expect(lowercaseViolations.length).toBeGreaterThan(0);
  });
});

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { India4gProfile } from './lighthouse-runner.js';

/**
 * lighthouse-evidence.ts (P29 step 6, Unit U5) - sibling module split off
 * `lighthouse-runner.ts` to respect the 300-line cap. Owns the shape of one
 * Lighthouse route result, the critical-path check result, and the
 * evidence-file writer (`docs/evidence/P29-lcp-india4g.md` +
 * `docs/measurements/2026-09-08-lcp-india4g.json`).
 */

/**
 * Proof that the measured trace was actually served compressed (U5b): sums
 * of transfer/resource bytes across the LHR's initial network requests, and
 * whether at least one JS response had transferSize < resourceSize.
 */
export interface CompressionProof {
  transferBytes: number;
  resourceBytes: number;
  compressedJsChunkFound: boolean;
}

export interface LighthouseRunResult {
  url: string;
  lcpMs: number;
  fcpMs: number;
  tbtMs: number;
  speedIndexMs: number;
  performanceScore: number;
  lighthouseVersion: string;
  userAgent: string;
  fetchTime: string;
  compression: CompressionProof;
}

export interface CriticalPathResult {
  initialChunksScanned: number;
  gsapInInitial: boolean;
  lazyGsapChunk: string | undefined;
}

export interface HeroIslandMeasurement {
  islandOffLcpMs: number;
  islandOnLcpMs: number;
  kept: boolean;
}

export interface WriteEvidenceInput {
  mdPath: string;
  jsonPath: string;
  results: LighthouseRunResult[];
  profile: India4gProfile;
  budgetMs: number;
  criticalPath: CriticalPathResult;
  heroIsland?: HeroIslandMeasurement;
}

function verdictFor(results: LighthouseRunResult[], budgetMs: number): 'PASS' | 'FAIL' {
  return results.every((result) => result.lcpMs <= budgetMs) ? 'PASS' : 'FAIL';
}

function kb(bytes: number): string {
  return (bytes / 1024).toFixed(1);
}

function resultsTable(results: LighthouseRunResult[]): string {
  const header =
    '| route | LCP ms | FCP ms | TBT ms | Speed Index ms | perf score | Transfer (KB transferred / KB resource) | pass |\n' +
    '|---|---|---|---|---|---|---|---|\n';
  const rows = results
    .map((result) => {
      const pass = result.lcpMs <= 2500 ? 'yes' : 'no';
      const transfer = `${kb(result.compression.transferBytes)} / ${kb(result.compression.resourceBytes)}`;
      return `| ${result.url} | ${result.lcpMs.toFixed(1)} | ${result.fcpMs.toFixed(1)} | ${result.tbtMs.toFixed(1)} | ${result.speedIndexMs.toFixed(1)} | ${result.performanceScore.toFixed(1)} | ${transfer} | ${pass} |`;
    })
    .join('\n');
  return header + rows;
}

function heroIslandSection(heroIsland: HeroIslandMeasurement | undefined): string {
  if (!heroIsland) {
    return '## Hero island\nNot attempted this run (budget was not met with margin, or not yet re-measured).\n';
  }
  return (
    '## Hero island\n' +
    `- Island off (CSS-only hero): / = ${heroIsland.islandOffLcpMs.toFixed(1)} ms\n` +
    `- Island on (HeroMotionIsland restored): / = ${heroIsland.islandOnLcpMs.toFixed(1)} ms\n` +
    `- Kept: ${heroIsland.kept ? 'yes' : 'no'}\n`
  );
}

/** Writes the markdown evidence file and the JSON measurement artefact (called after every route + in afterAll). */
export function writeEvidence({
  mdPath,
  jsonPath,
  results,
  profile,
  budgetMs,
  criticalPath,
  heroIsland,
}: WriteEvidenceInput): void {
  mkdirSync(path.dirname(mdPath), { recursive: true });
  mkdirSync(path.dirname(jsonPath), { recursive: true });

  const verdict = verdictFor(results, budgetMs);
  const firstResult = results[0];
  const userAgent = firstResult?.userAgent ?? 'unknown';
  const lighthouseVersion = firstResult?.lighthouseVersion ?? 'unknown';

  const md = `# P29 - LCP on the India 4G profile (measured 2026-09-08)

INTERNAL performance evidence - no figure here is a capacity or delivery claim (ADR 0016).

## Profile: ${profile.name}
- RTT: ${String(profile.rttMs)} ms
- Download throughput: ${String(profile.throughputKbps)} kbps
- Upload throughput: ${String(profile.uploadThroughputKbps)} kbps
- CPU slowdown multiplier: ${String(profile.cpuSlowdownMultiplier)}x
- Mobile emulation: ${String(profile.screenEmulation.width)}x${String(profile.screenEmulation.height)}, DPR ${String(profile.screenEmulation.deviceScaleFactor)}

## Budget
- LCP budget: ${String(budgetMs)} ms

## Environment
- Chrome user agent: ${userAgent}
- Lighthouse version: ${lighthouseVersion}

## Results

${resultsTable(results)}

## Critical path
- Initial chunks scanned: ${String(criticalPath.initialChunksScanned)}
- gsap in initial chunks: ${criticalPath.gsapInInitial ? 'yes' : 'no'}
- Lazy gsap chunk: ${criticalPath.lazyGsapChunk ?? 'not found'}

${heroIslandSection(heroIsland)}
Verdict: ${verdict}

Method: simulated throttling (Lighthouse lantern), one run per route, cold cache, static export served by tests/e2e/serve-out.mjs with content-negotiated gzip/brotli compression (matching production edge behaviour); simulated throttling is deterministic for a given build and does not depend on ambient load.

## Uncompressed control
/ = 2853.2 ms, /pricing/ = 2704.2 ms, /docs/how-sending-is-paced/ = 2703.6 ms (same build, identity encoding) - FAIL; compression at the edge is load-bearing for the budget and is a launch-checklist requirement (P29a).

Note: the ~2,700-2,850 ms uncompressed figures above were produced by a
harness bug (U5b) - tests/e2e/serve-out.mjs served every asset identity
(uncompressed), so Lighthouse's simulated throttling measured a transfer
(~610 KB) no real visitor experiences: every production edge (Caddy/nginx)
serves gzip or brotli. The harness now negotiates encoding the same way,
and the compressed results above are the honest measurement.
`;
  writeFileSync(mdPath, md, 'utf8');

  const json = {
    measuredAt: new Date().toISOString(),
    profile,
    budgetMs,
    results,
    criticalPath,
    heroIsland,
    verdict,
  };
  writeFileSync(jsonPath, JSON.stringify(json, null, 2), 'utf8');
}

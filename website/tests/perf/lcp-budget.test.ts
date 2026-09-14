import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  collectInitialScriptPaths,
  ensureExport,
  launchChrome,
  readIndia4gProfile,
  readLighthouserc,
  runLighthouse,
  startStaticServer,
  writeEvidence,
  WEBSITE_DIR,
  type CriticalPathResult,
  type LighthouseRunResult,
} from './lighthouse-runner.js';

/**
 * lcp-budget.test.ts (P29 step 6, Unit U5) - the performance gate: LCP <=
 * 2,500 ms on the India-4G profile against the BUILT static export, driven
 * by real Chrome + Lighthouse (simulated throttling). Run via
 * `pnpm -F website run test:perf` (CI step `website-lcp`). One Chrome
 * instance and one static server are shared across all cases in this file
 * (`fileParallelism: false` in `vitest.perf.config.ts`), started in
 * `beforeAll` and always torn down in `afterAll` - the evidence files are
 * written incrementally as each route's result comes in, so a failing
 * assertion never leaves stale or missing evidence behind.
 */

const PORT = 3907;
const OUT_DIR = path.join(WEBSITE_DIR, 'out');
const MD_PATH = path.join(WEBSITE_DIR, '..', 'docs', 'evidence', 'P29-lcp-india4g.md');
const JSON_PATH = path.join(
  WEBSITE_DIR,
  '..',
  'docs',
  'measurements',
  '2026-09-08-lcp-india4g.json',
);
const BUDGET_MS = 2500;

const profile = readIndia4gProfile();

/** Every `.js` file under `dir`, recursively (no dependency on a glob package). */
function listJsFilesRecursively(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(dir, entry);
    if (statSync(entryPath).isDirectory()) {
      files.push(...listJsFilesRecursively(entryPath));
    } else if (entry.endsWith('.js')) {
      files.push(entryPath);
    }
  }
  return files;
}

let chrome: { port: number; kill: () => Promise<void> };
let server: { close: () => void };
const results: LighthouseRunResult[] = [];
let criticalPath: CriticalPathResult = {
  initialChunksScanned: 0,
  gsapInInitial: false,
  lazyGsapChunk: undefined,
};
/**
 * '/' is measured exactly once, in `beforeAll`, and stored here - both the
 * budget assertion and the compression assertion read this same result,
 * rather than one `it` depending on shared mutable `results` state having
 * been populated by a PRECEDING `it` (a same-file ordering dependency this
 * fix removes; both cases are independently rerunnable in any order now).
 */
let homeResult: LighthouseRunResult;

// Fixed record of the island-off vs island-on comparison (P29 step 6/U5b):
// island-off was measured with the compression-fixed harness before the
// island was restored (docs/evidence/P29-lcp-india4g.md, prior run of this
// suite); island-on is this run's live `/` measurement. Both routes stayed
// well under budget in both configurations, so the island was kept - see
// hero.tsx's header comment.
const HERO_ISLAND_OFF_LCP_MS = 1508.9;

function persistEvidence(): void {
  const home = results.find((result) => result.url.endsWith(':3907/'));
  writeEvidence({
    mdPath: MD_PATH,
    jsonPath: JSON_PATH,
    results,
    profile,
    budgetMs: BUDGET_MS,
    criticalPath,
    heroIsland: home
      ? {
          islandOffLcpMs: HERO_ISLAND_OFF_LCP_MS,
          islandOnLcpMs: home.lcpMs,
          kept: true,
        }
      : undefined,
  });
}

async function measure(routePath: string): Promise<LighthouseRunResult> {
  const url = `http://127.0.0.1:${String(PORT)}${routePath}`;
  const result = await runLighthouse(url, chrome.port, profile);
  console.log(`[lcp-budget] ${routePath}: LCP=${result.lcpMs.toFixed(0)}ms`);
  results.push(result);
  persistEvidence();
  return result;
}

describe('website LCP budget on the India 4G profile (P29 step 6)', () => {
  beforeAll(async () => {
    ensureExport(WEBSITE_DIR);
    server = await startStaticServer(OUT_DIR, PORT);
    chrome = await launchChrome();
    homeResult = await measure('/');
  }, 900_000);

  afterAll(async () => {
    persistEvidence();
    await chrome?.kill();
    server?.close();
  }, 900_000);

  it('home_lcp_is_under_2500ms_on_the_india_4g_profile', () => {
    const lighthouserc = readLighthouserc();
    expect(lighthouserc.ci.assert.assertions['largest-contentful-paint']).toEqual([
      'error',
      { maxNumericValue: 2500 },
    ]);

    expect(homeResult.lcpMs).toBeLessThanOrEqual(2500);
  });

  it('the_measured_trace_was_served_compressed', () => {
    // This proves the LCP measurement above did not come from a silent
    // identity response (see serve-out.mjs and lighthouse-runner.ts's
    // deriveCompressionProof) - both cases assert against the SAME
    // `homeResult`, measured once in `beforeAll`, so this case no longer
    // depends on the preceding `it` having run first.
    expect(homeResult.compression.compressedJsChunkFound).toBe(true);
    expect(homeResult.compression.transferBytes).toBeLessThan(homeResult.compression.resourceBytes);
  });

  it('pricing_and_docs_pages_are_under_the_same_budget', async () => {
    // Both routes are measured (and persisted) BEFORE either assertion runs,
    // so a budget miss on `/pricing/` never prevents `/docs/...` from being
    // measured - the evidence file must always reflect all three routes,
    // failing or not.
    const pricing = await measure('/pricing/');
    const docs = await measure('/docs/how-sending-is-paced/');

    expect(pricing.lcpMs).toBeLessThanOrEqual(2500);
    expect(docs.lcpMs).toBeLessThanOrEqual(2500);
  });

  it('the_hero_animation_is_not_on_the_critical_path', () => {
    const indexHtml = readFileSync(path.join(OUT_DIR, 'index.html'), 'utf8');
    const initialPaths = collectInitialScriptPaths(indexHtml);
    expect(initialPaths.length).toBeGreaterThan(0);

    const gsapWord = /\bgsap\b/;
    const initialChunkTexts = initialPaths.map((scriptPath) =>
      readFileSync(path.join(OUT_DIR, scriptPath.replace(/^\//, '')), 'utf8'),
    );
    const gsapInInitial = initialChunkTexts.some((text) => gsapWord.test(text));
    expect(gsapInInitial).toBe(false);

    // The motion island was dropped from the home page (P29 step 6 hero
    // fallback escalation step 2 - see hero.tsx's header comment and
    // docs/evidence/P29-lcp-india4g.md): gsap may now be absent from the
    // build entirely, which is a STRONGER guarantee than "lazy" (it is not
    // shipped at all). Either outcome satisfies "not on the critical path";
    // only "present in an initial chunk" (asserted above) would violate it.
    const allChunks = listJsFilesRecursively(path.join(OUT_DIR, '_next', 'static', 'chunks'));
    const initialAbsolutePaths = new Set(
      initialPaths.map((scriptPath) => path.join(OUT_DIR, scriptPath.replace(/^\//, ''))),
    );
    const lazyGsapChunk = allChunks
      .filter((chunkPath) => !initialAbsolutePaths.has(chunkPath))
      .find((chunkPath) => gsapWord.test(readFileSync(chunkPath, 'utf8')));

    criticalPath = {
      initialChunksScanned: initialPaths.length,
      gsapInInitial,
      lazyGsapChunk: lazyGsapChunk ? path.relative(OUT_DIR, lazyGsapChunk) : undefined,
    };
    persistEvidence();
  });

  it('the_static_export_contains_the_ui_smoke_markers', () => {
    const indexHtml = readFileSync(path.join(OUT_DIR, 'index.html'), 'utf8');
    expect(indexHtml).toContain('data-ui-smoke="button"');
    expect(indexHtml).toContain('data-ui-smoke="card"');
    expect(indexHtml).toContain('data-ui-smoke="badge"');
  });

  it('evidence_is_written_with_the_measured_numbers', () => {
    const md = readFileSync(MD_PATH, 'utf8');
    expect(md).toContain('http://127.0.0.1:3907/');
    expect(md).toContain('http://127.0.0.1:3907/pricing/');
    expect(md).toContain('http://127.0.0.1:3907/docs/how-sending-is-paced/');
    expect(md).toContain(profile.name);
    expect(/Verdict: (PASS|FAIL)/.test(md)).toBe(true);
    expect(md).toContain('## Hero island');
    expect(md).toContain('## Uncompressed control');

    const json = JSON.parse(readFileSync(JSON_PATH, 'utf8')) as { results: unknown[] };
    expect(json.results.length).toBe(3);
  });
});

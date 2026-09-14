import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CompressionProof, LighthouseRunResult } from './lighthouse-evidence.js';

/**
 * lighthouse-runner.ts (P29 step 6, Unit U5) - helper module for the LCP
 * budget suite (`lcp-budget.test.ts`). No test code lives here: this file
 * builds the static export if missing, serves it, launches Chrome, and
 * drives Lighthouse under simulated India-4G throttling. Evidence-file
 * writing lives in the sibling module `lighthouse-evidence.ts` (split to
 * respect the 300-line cap). See `website/tests/perf/india-4g.json` for the
 * throttling profile and `website/lighthouserc.json` for the budget
 * definition (both read as data, never hand-copied here).
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEBSITE_DIR = path.resolve(HERE, '..', '..');
const REPO_ROOT = path.resolve(WEBSITE_DIR, '..');

export interface ScreenEmulationProfile {
  mobile: boolean;
  width: number;
  height: number;
  deviceScaleFactor: number;
  disabled: boolean;
}

export interface LighthouseThrottlingProfile {
  rttMs: number;
  throughputKbps: number;
  requestLatencyMs: number;
  downloadThroughputKbps: number;
  uploadThroughputKbps: number;
  cpuSlowdownMultiplier: number;
}

export interface India4gProfile {
  name: string;
  rttMs: number;
  throughputKbps: number;
  uploadThroughputKbps: number;
  cpuSlowdownMultiplier: number;
  formFactor: 'mobile' | 'desktop';
  screenEmulation: ScreenEmulationProfile;
  lighthouseThrottling: LighthouseThrottlingProfile;
}

/** Builds the static export (`website/out`) if it does not already exist. */
export function ensureExport(websiteDir: string): void {
  if (existsSync(path.join(websiteDir, 'out', 'index.html'))) {
    return;
  }
  const result = spawnSync('pnpm', ['-F', 'website', 'run', 'build'], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    timeout: 10 * 60 * 1000,
    shell: true,
  });
  if (result.status !== 0) {
    throw new Error(
      `ensureExport: "pnpm -F website run build" failed (status ${String(result.status)}, error ${String(result.error)})`,
    );
  }
}

async function pollUntilOk(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(
    `pollUntilOk: ${url} did not respond 200 within ${String(timeoutMs)}ms (${String(lastError)})`,
  );
}

/** Starts the dependency-free static file server (`tests/e2e/serve-out.mjs`) against `outDir`. */
export async function startStaticServer(
  outDir: string,
  port: number,
): Promise<{ close: () => void }> {
  const { spawn } = await import('node:child_process');
  const child = spawn(
    process.execPath,
    [path.join(WEBSITE_DIR, 'tests', 'e2e', 'serve-out.mjs'), String(port), outDir],
    { cwd: WEBSITE_DIR, stdio: 'ignore' },
  );
  await pollUntilOk(`http://127.0.0.1:${String(port)}/`, 20_000);
  return {
    close: () => {
      child.kill();
    },
  };
}

const KNOWN_CHROME_PATHS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  path.join(
    process.env.LOCALAPPDATA ?? '',
    'ms-playwright',
    'chromium-1234',
    'chrome-win64',
    'chrome.exe',
  ),
];

/** Launches Chrome via chrome-launcher, preferring `CHROME_PATH`, then known machine paths. */
export async function launchChrome(): Promise<{ port: number; kill: () => Promise<void> }> {
  const chromeLauncher = await import('chrome-launcher');
  const candidates = [process.env.CHROME_PATH, ...KNOWN_CHROME_PATHS].filter(
    (candidate): candidate is string => Boolean(candidate),
  );
  const chromePath = candidates.find((candidate) => existsSync(candidate));
  if (!chromePath && candidates.length > 0) {
    throw new Error(
      `launchChrome: no Chrome binary found. Tried: ${candidates.join(', ')}. Set CHROME_PATH to override.`,
    );
  }
  const chrome = await chromeLauncher.launch({
    chromeFlags: ['--headless=new', '--no-first-run', '--disable-gpu'],
    ...(chromePath ? { chromePath } : {}),
  });
  return {
    port: chrome.port,
    // chrome-launcher's own `kill()` deletes its Chrome-profile temp dir as
    // part of shutdown; on Windows that delete can race a file handle Chrome
    // has not yet released and throw `EPERM`. The measurements are already
    // taken and persisted by this point - a leftover temp dir is harmless,
    // so this is a best-effort cleanup, never a reason to fail the suite.
    kill: async () => {
      try {
        await chrome.kill();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EPERM') {
          throw error;
        }
      }
    },
  };
}

interface LighthouseAudits {
  [auditId: string]: { numericValue: number; details?: { items?: NetworkRequestItem[] } };
}

interface LighthouseResult {
  audits: LighthouseAudits;
  categories: { performance: { score: number } };
  lighthouseVersion: string;
  environment: { hostUserAgent: string };
  fetchTime: string;
}

interface NetworkRequestItem {
  url: string;
  transferSize?: number;
  resourceSize?: number;
  resourceType?: string;
}

/**
 * Derives the compression proof (U5b) from the LHR's `network-requests`
 * audit: sums transfer/resource bytes across every initial request, and
 * checks whether at least one JS response was actually served with
 * transferSize < resourceSize - a silent identity response from the static
 * server would otherwise make the LCP pass meaningless (Lighthouse's
 * simulated throttling uses each response's real transferSize).
 */
function deriveCompressionProof(items: NetworkRequestItem[]): CompressionProof {
  let transferBytes = 0;
  let resourceBytes = 0;
  let compressedJsChunkFound = false;
  for (const item of items) {
    transferBytes += item.transferSize ?? 0;
    resourceBytes += item.resourceSize ?? 0;
    const isJs = item.url.endsWith('.js');
    if (isJs && (item.transferSize ?? 0) < (item.resourceSize ?? 0)) {
      compressedJsChunkFound = true;
    }
  }
  return { transferBytes, resourceBytes, compressedJsChunkFound };
}

/** Runs Lighthouse against `url` (a full URL) using Chrome already listening on `port`. */
export async function runLighthouse(
  url: string,
  port: number,
  profile: India4gProfile,
): Promise<LighthouseRunResult> {
  const { default: lighthouse } = await import('lighthouse');
  const runnerResult = await lighthouse(
    url,
    { port, output: 'json', logLevel: 'error' },
    {
      extends: 'lighthouse:default',
      settings: {
        onlyCategories: ['performance'],
        formFactor: profile.formFactor,
        screenEmulation: profile.screenEmulation,
        throttlingMethod: 'simulate',
        throttling: profile.lighthouseThrottling,
      },
    },
  );
  if (!runnerResult) {
    throw new Error(`runLighthouse: no result for ${url}`);
  }
  const lhr = runnerResult.lhr as unknown as LighthouseResult;
  const networkItems = lhr.audits['network-requests']?.details?.items ?? [];
  const compression = deriveCompressionProof(networkItems);
  if (!compression.compressedJsChunkFound) {
    throw new Error(
      `runLighthouse: no initial JS response for ${url} had transferSize < resourceSize - ` +
        'the static server is not compressing responses, so this measurement would not ' +
        'reflect a real production edge (see serve-out.mjs).',
    );
  }
  return {
    url,
    lcpMs: lhr.audits['largest-contentful-paint'].numericValue,
    fcpMs: lhr.audits['first-contentful-paint'].numericValue,
    tbtMs: lhr.audits['total-blocking-time'].numericValue,
    speedIndexMs: lhr.audits['speed-index'].numericValue,
    performanceScore: lhr.categories.performance.score * 100,
    lighthouseVersion: lhr.lighthouseVersion,
    userAgent: lhr.environment.hostUserAgent,
    fetchTime: lhr.fetchTime,
    compression,
  };
}

/** Every `/_next/...` script or modulepreload/preload href referenced in the built `index.html`. */
export function collectInitialScriptPaths(indexHtml: string): string[] {
  const paths = new Set<string>();
  const scriptSrcPattern = /<script[^>]*\ssrc="(\/_next\/[^"]+)"/g;
  const linkHrefPattern =
    /<link[^>]*\srel="(?:preload|modulepreload)"[^>]*\shref="(\/_next\/[^"]+\.js)"/g;
  for (const match of indexHtml.matchAll(scriptSrcPattern)) {
    paths.add(match[1]);
  }
  for (const match of indexHtml.matchAll(linkHrefPattern)) {
    paths.add(match[1]);
  }
  return [...paths];
}

export type {
  CompressionProof,
  CriticalPathResult,
  LighthouseRunResult,
} from './lighthouse-evidence.js';
export { writeEvidence } from './lighthouse-evidence.js';

export function readIndia4gProfile(): India4gProfile {
  const raw = readFileSync(path.join(HERE, 'india-4g.json'), 'utf8');
  return JSON.parse(raw) as India4gProfile;
}

export function readLighthouserc(): {
  ci: {
    assert: { assertions: { 'largest-contentful-paint': [string, { maxNumericValue: number }] } };
  };
} {
  const raw = readFileSync(path.join(WEBSITE_DIR, 'lighthouserc.json'), 'utf8');
  return JSON.parse(raw);
}

export { WEBSITE_DIR };

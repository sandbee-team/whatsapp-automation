import path from 'node:path';
import { readFileSync } from 'node:fs';
import { buildTarArchive, collectSemgrepSources } from './security-scan-tar.js';

/**
 * security-scan-lib.ts (P29a launch-hardening Unit U1) - PURE argv builders
 * and result classifiers for the three pinned-Docker-image security
 * scanners (semgrep, trivy, gitleaks). No I/O here - `security-scan-runner.ts`
 * does the actual `spawnSync` call and file reads; the thin CLIs
 * (`scripts/scan-*.ts`) wire it to `process.exit`.
 *
 * Every scanner runs as a pinned Docker image (`<image>:<tag>@sha256:<digest>`
 * - see `docs/evidence/P29-security-scans.md` for the exact pins) mounting
 * the target directory read-only at `/src` (ADR 0003: filesystem mode only,
 * never a git-aware mode - ADR 0003 forbids this repo from ever becoming a
 * git repository, so no scanner may be invoked in a mode that assumes one).
 *
 * semgrep is a special case, in two ways. First (perf): it does NOT bind-mount
 * the repo - on Windows Docker Desktop, per-file reads over a bind mount made
 * a full-tree scan take 1,228s wall clock under 1.5 min of actual CPU (see
 * `docs/evidence/P29-security-scans.md`). Instead the exact source set
 * (`collectSemgrepSources`) is packed into a ustar archive
 * (`security-scan-tar.ts`) and streamed on stdin to `docker run -i`, which
 * extracts it into the container's OWN filesystem before scanning - no mount
 * at all. Second (rule-id namespacing): semgrep derives a rule-id namespace
 * prefix from the config file's mount name whenever the config and the scan
 * target are NOT under the SAME mount root (e.g.
 * `wp.no-tls-verification-disabled` becomes `src-repo.wp.no-tls-...` if the
 * config lives on a second `/src-repo` mount) - verified empirically, see
 * `docs/evidence/P29-security-scans.md`. The streamed archive keeps both
 * `.semgrep.yml` and every source file under the SAME extracted `/src` root,
 * so this prefixing never triggers. Trivy and gitleaks have no such prefix
 * behaviour and no perf problem (9s total for both), so their builders keep
 * the simpler two-mount bind shape (config on `/src-repo`, scan target on
 * `/src`) - which also means a path-based fixture exclusion in
 * `.gitleaks.toml`/`trivy.yaml` (keyed off the REPORTED path) still only
 * ever fires within a real full-repo scan, never when a test points
 * `scanRoot` directly at that same fixture as its OWN `/src` mount (the
 * reported path is identical either way for gitleaks/trivy, so this
 * distinction is deliberate scoping at the call site, not a path trick -
 * see `security-scan.test.ts`'s `each_scanner_fails_on_its_seeded_fixture`,
 * which points `scanRoot` at a fixture the real-tree run would otherwise
 * skip).
 */

function toContainerSubpath(repoRoot: string, scanRoot: string): string {
  if (scanRoot === repoRoot) return '/src';
  const relative = path.relative(repoRoot, scanRoot).split(path.sep).join('/');
  return `/src/${relative}`;
}

export interface SpawnLike {
  (
    cmd: string,
    args: string[],
    opts: { cwd: string; input?: Buffer; timeout?: number },
  ): { status: number | null; stdout: string; stderr: string; error?: Error };
}

export type ScannerName = 'semgrep' | 'trivy' | 'secret-scan';

export interface ScannerArgv {
  cmd: string;
  args: string[];
  /**
   * Bytes to pipe to the process's stdin (currently only semgrep - the
   * streamed ustar archive). `undefined` for trivy/gitleaks, which still
   * bind-mount their scan target.
   */
  input?: Buffer;
}

/**
 * Semgrep CLI `--exclude` patterns for the real repo-root scan. These are
 * enforced via the CLI flag, NOT `.semgrep.yml`'s own top-level `paths:
 * exclude:` block - verified empirically that the YAML-level exclude is
 * unreliable on the pinned semgrep version (a real test file,
 * `app/backend/src/platform/http/safe-fetch-tls.test.ts`, still matched
 * `wp.no-tls-verification-disabled` despite `**\/*.test.ts` being listed
 * there - see docs/evidence/P29-security-scans.md). The CLI flag is the
 * mechanism that is actually proven to work.
 */
const SEMGREP_CLI_EXCLUDES = [
  'node_modules',
  'dist',
  'coverage',
  'website/out',
  '.next',
  'demo',
  '.memory',
  '.claude',
  'scripts/guards/__fixtures__',
  '*.test.ts',
  '*.test.tsx',
  '*.spec.ts',
  '*.integration.test.ts',
];

/**
 * `docker run --rm -i <image> sh -c 'mkdir -p /src && tar -xf - -C /src &&
 * cd /src && semgrep scan --config /src/.semgrep.yml ... <target>'`. No
 * bind mount: the exact source set (`collectSemgrepSources`) plus
 * `.semgrep.yml` is packed into a ustar archive (`buildTarArchive`) and
 * returned as `input`, piped to the container's stdin and extracted into
 * its OWN filesystem - see this file's header for why. `scanRoot` defaults
 * to the real repo root; tests override it to point at a single fixture
 * directory (still addressed as a subpath of the SAME extracted `/src` root
 * - see `toContainerSubpath` - so the rule's `paths.include` on real
 * production paths simply finds nothing there and the *fixture's own*
 * path-unscoped pattern rule fires instead).
 */
export function buildSemgrepArgv(
  repoRoot: string,
  image: string,
  scanRoot: string = repoRoot,
): ScannerArgv {
  // The CLI --exclude flags only apply to a repo-root scan: when `scanRoot`
  // IS `scripts/guards/__fixtures__/**` itself (the fixture-proof test),
  // excluding that same path would exclude the entire scan target and hide
  // every finding - verified empirically, see
  // docs/evidence/P29-security-scans.md.
  const excludeArgs =
    scanRoot === repoRoot ? SEMGREP_CLI_EXCLUDES.flatMap((pattern) => ['--exclude', pattern]) : [];
  const semgrepCommand = [
    'semgrep',
    'scan',
    '--config',
    '/src/.semgrep.yml',
    '--metrics=off',
    '--error',
    '--json',
    '--quiet',
    ...excludeArgs,
    toContainerSubpath(repoRoot, scanRoot),
  ].join(' ');
  const shellScript = `mkdir -p /src && tar -xf - -C /src && cd /src && ${semgrepCommand}`;
  const args = ['run', '--rm', '-i', image, 'sh', '-c', shellScript];

  const sourcePaths = collectSemgrepSources(repoRoot, scanRoot);
  const archiveEntries = sourcePaths.map((relativePosixPath) => ({
    path: relativePosixPath,
    content: readFileSync(path.join(repoRoot, ...relativePosixPath.split('/'))),
  }));
  const input = buildTarArchive(archiveEntries);

  return { cmd: 'docker', args, input };
}

/**
 * `docker run --rm -v <scanRoot>:/src:ro -v <repoRoot>:/src-repo:ro -v
 * wp-trivy-cache:/root/.cache/ <image> fs --config
 * /src-repo/infra/deploy/trivy.yaml ... /src`. Config and scan target are on
 * DIFFERENT mounts (unlike semgrep - see this file's header): the target
 * mount is always `scanRoot` itself, so `skip-dirs` patterns like
 * `**\/__fixtures__/**` in `trivy.yaml` never accidentally exclude a fixture
 * a test points `scanRoot` directly at (its reported path inside `/src`
 * never contains the `__fixtures__` segment in that case). The `/src-repo`
 * mount is only added when `scanRoot` differs from `repoRoot` - the real
 * production invocation needs just the one mount.
 */
export function buildTrivyArgv(
  repoRoot: string,
  image: string,
  scanRoot: string = repoRoot,
): ScannerArgv {
  const configRoot = scanRoot === repoRoot ? '/src' : '/src-repo';
  const args = [
    'run',
    '--rm',
    '-v',
    `${scanRoot}:/src:ro`,
    ...(scanRoot === repoRoot ? [] : ['-v', `${repoRoot}:/src-repo:ro`]),
    '-v',
    'wp-trivy-cache:/root/.cache/',
    image,
    'fs',
    '--config',
    `${configRoot}/infra/deploy/trivy.yaml`,
    '--exit-code',
    '1',
    '--severity',
    'HIGH,CRITICAL',
    '--format',
    'json',
    '/src',
  ];
  return { cmd: 'docker', args };
}

/**
 * `docker run --rm -v <scanRoot>:/src:ro -v <repoRoot>:/src-repo:ro -v
 * <outDir>:/out <image> dir /src --config /src-repo/.gitleaks.toml ...`.
 * Filesystem mode ONLY - the `dir` subcommand (never `detect`/`git`/
 * `protect`), because this repo must never become a git repository (ADR
 * 0003). Config and scan target are on different mounts, same reasoning as
 * `buildTrivyArgv` (a path-based `.gitleaks.toml` allowlist entry must only
 * ever apply within a real full-repo scan, never when a test points
 * `scanRoot` directly at that same fixture). `--report-path` targets a
 * writable bind mount rather than `/dev/stdout`: `/dev/stdout` inside this
 * containerized gitleaks build does not reliably flush through Docker's own
 * stdout stream (verified empirically - see
 * `docs/evidence/P29-security-scans.md`), so the report is written to a real
 * file on a mounted output directory and read back by the caller instead.
 */
export function buildSecretScanArgv(
  repoRoot: string,
  image: string,
  outDir: string,
  scanRoot: string = repoRoot,
): ScannerArgv {
  const configRoot = scanRoot === repoRoot ? '/src' : '/src-repo';
  const args = [
    'run',
    '--rm',
    '-v',
    `${scanRoot}:/src:ro`,
    ...(scanRoot === repoRoot ? [] : ['-v', `${repoRoot}:/src-repo:ro`]),
    '-v',
    `${outDir}:/out`,
    image,
    'dir',
    '/src',
    '--config',
    `${configRoot}/.gitleaks.toml`,
    '--no-banner',
    '--redact',
    '--exit-code',
    '1',
    '--report-format',
    'json',
    '--report-path',
    '/out/report.json',
  ];
  return { cmd: 'docker', args };
}

// Classification of a scanner's raw spawn result + per-scanner findings
// summary parsing live in `./security-scan-classify.js` (kept out of this
// file to stay under its `max-lines: 300` cap - same discipline as
// `registry-adapters.ts`). Re-exported here so existing callers of
// `security-scan-lib.js` keep a single import surface.
export {
  classifyScannerExit,
  parseFindingsSummary,
  type ScannerExitKind,
  type ScannerClassification,
  type FindingsSummary,
} from './security-scan-classify.js';

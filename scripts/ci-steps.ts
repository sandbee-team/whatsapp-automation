import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The one ordered CI step list. `scripts/ci.ps1` and `scripts/ci.sh` are thin
 * preflight wrappers that both delegate to this file - they never hardcode a
 * step command, so the two gates cannot drift (see
 * `ci_ps1_and_ci_sh_run_the_same_ordered_steps`).
 *
 * Order: format -> lint -> depcruise -> domain browser build ->
 * guard meta-assertion -> tenant-scope -> single-reserve -> single-debit ->
 * send-origin -> copy -> no-raw-hex -> ui-client-directive ->
 * serialisation-boundary -> shutdown-purity -> placement-neutrality ->
 * box-memory -> capacity-gate -> no-direct-publish -> api-key-routes ->
 * no-insecure-tls ->
 * health-writers -> scheduler-queries -> forbidden-mechanisms ->
 * no-bulk-lookup -> metric-inventory -> metric-manifest -> dashboards ->
 * alert-rules -> semgrep -> trivy -> secret-scan -> typecheck -> unit ->
 * integration -> build -> website-build -> website-lcp. (P29 adds the
 * static-export build and the LCP gate; P29a adds the three security scans.)
 */
export interface CiStep {
  name: string;
  command: string;
}

export const CI_STEPS: CiStep[] = [
  { name: 'format', command: 'pnpm run format:check' },
  { name: 'lint', command: 'pnpm run lint' },
  { name: 'depcruise', command: 'pnpm run guards:depcruise' },
  { name: 'domain-browser-build', command: 'pnpm run domain:browser-build' },
  { name: 'guard-meta-assertion', command: 'pnpm run guards:meta' },
  { name: 'tenant-scope', command: 'pnpm run check:tenant-scope' },
  { name: 'single-reserve', command: 'pnpm run check:single-reserve' },
  { name: 'single-debit', command: 'pnpm run check:single-debit' },
  { name: 'send-origin', command: 'pnpm run check:send-origin' },
  { name: 'copy', command: 'pnpm run check:copy' },
  { name: 'no-raw-hex', command: 'pnpm run check:no-raw-hex' },
  { name: 'ui-client-directive', command: 'pnpm run check:ui-client-directive' },
  { name: 'serialisation-boundary', command: 'pnpm run check:serialisation-boundary' },
  { name: 'shutdown-purity', command: 'pnpm run check:shutdown-purity' },
  { name: 'placement-neutrality', command: 'pnpm run check:placement-neutrality' },
  { name: 'box-memory', command: 'pnpm run check:box-memory' },
  { name: 'capacity-gate', command: 'pnpm run check:capacity-gate' },
  { name: 'no-direct-publish', command: 'pnpm run check:no-direct-publish' },
  { name: 'api-key-routes', command: 'pnpm run check:api-key-routes' },
  { name: 'no-insecure-tls', command: 'pnpm run check:no-insecure-tls' },
  { name: 'health-writers', command: 'pnpm run check:health-writers' },
  { name: 'scheduler-queries', command: 'pnpm run check:scheduler-queries' },
  { name: 'forbidden-mechanisms', command: 'pnpm run check:forbidden-mechanisms' },
  { name: 'no-bulk-lookup', command: 'pnpm run check:no-bulk-lookup' },
  { name: 'metric-inventory', command: 'pnpm run check:metric-inventory' },
  { name: 'metric-manifest', command: 'pnpm run check:metric-manifest' },
  { name: 'dashboards', command: 'pnpm run check:dashboards' },
  { name: 'alert-rules', command: 'pnpm run check:alert-rules' },
  { name: 'semgrep', command: 'pnpm run check:semgrep' },
  { name: 'trivy', command: 'pnpm run check:trivy' },
  { name: 'secret-scan', command: 'pnpm run check:secret-scan' },
  { name: 'typecheck', command: 'pnpm run typecheck' },
  { name: 'unit', command: 'pnpm run test:unit' },
  { name: 'integration', command: 'pnpm run test:int' },
  { name: 'build', command: 'pnpm run build' },
  { name: 'website-build', command: 'pnpm -F website run build' },
  { name: 'website-lcp', command: 'pnpm -F website run test:perf' },
];

function listSteps(): void {
  for (const step of CI_STEPS) {
    console.log(`${step.name} -> ${step.command}`);
  }
}

function runSteps(): void {
  for (const step of CI_STEPS) {
    console.log(`\n--- CI step: ${step.name} (${step.command}) ---`);
    const result = spawnSync(step.command, {
      cwd: process.cwd(),
      stdio: 'inherit',
      shell: true,
    });
    if (result.status !== 0) {
      console.error(`\nCI FAILED at step ${step.name}`);
      process.exit(1);
    }
  }
  console.log(`\nCI GREEN — all ${CI_STEPS.length} steps passed`);
}

const isMain =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
  const mode = process.argv[2];
  if (mode === 'list') {
    listSteps();
  } else if (mode === 'run' || mode === undefined) {
    runSteps();
  } else {
    console.error(`Unknown mode "${mode}". Use "run" or "list".`);
    process.exit(1);
  }
}

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runScanner } from './guards/security-scan-runner.js';

/**
 * scan-trivy.ts (P29a launch-hardening Unit U1) - thin CLI wrapping
 * `runScanner('trivy')`. See `scan-semgrep.ts` for the shared shape.
 */
function main(): void {
  const outcome = runScanner('trivy');
  console.log(outcome.summary);
  for (const violation of outcome.violations) {
    console.log(`  ${violation.file}: ${violation.message}`);
  }
  if (outcome.exitCode === 2) {
    console.error(
      'To run trivy: docker pull aquasec/trivy:0.58.1, then let this script run it as a ' +
        'pinned image - see docs/evidence/P29-security-scans.md for the exact digest.',
    );
  }
  process.exit(outcome.exitCode);
}

const isMain =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
  main();
}

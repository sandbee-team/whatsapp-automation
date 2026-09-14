import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runScanner } from './guards/security-scan-runner.js';

/**
 * scan-secrets.ts (P29a launch-hardening Unit U1) - thin CLI wrapping
 * `runScanner('secret-scan')` (gitleaks, filesystem mode only - ADR 0003).
 * See `scan-semgrep.ts` for the shared shape.
 */
function main(): void {
  const outcome = runScanner('secret-scan');
  console.log(outcome.summary);
  for (const violation of outcome.violations) {
    console.log(`  ${violation.file}: ${violation.message}`);
  }
  if (outcome.exitCode === 2) {
    console.error(
      'To run the secret scanner: docker pull zricethezav/gitleaks:v8.29.0, then let this ' +
        'script run it as a pinned image - see docs/evidence/P29-security-scans.md for the exact digest.',
    );
  }
  process.exit(outcome.exitCode);
}

const isMain =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
  main();
}

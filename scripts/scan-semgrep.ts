import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runScanner } from './guards/security-scan-runner.js';

/**
 * scan-semgrep.ts (P29a launch-hardening Unit U1) - thin CLI wrapping
 * `runScanner('semgrep')`. Prints the classification summary and exits with
 * the classified code (see `security-scan-lib.ts`'s `classifyScannerExit`
 * for what each code means - nothing but a clean scan exits 0).
 */
function main(): void {
  const outcome = runScanner('semgrep');
  console.log(outcome.summary);
  for (const violation of outcome.violations) {
    console.log(`  ${violation.file}: ${violation.message}`);
  }
  if (outcome.exitCode === 2) {
    console.error(
      'To run semgrep: docker pull semgrep/semgrep:1.99.0, then let this script run it as a ' +
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

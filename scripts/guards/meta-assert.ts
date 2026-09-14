import { readFileSync } from 'node:fs';
import path from 'node:path';
import { GUARDS, REPO_ROOT, parsePhaseStatus, resolveFiles } from './registry.js';

/**
 * CI-facing runner for the guard registry meta-assertion. Prints one line
 * per guard, then a summary line. Exits 1 if a guard matches zero files and
 * either declares no `activatesIn` phase, or its `activatesIn` phase is
 * already `done`.
 */
function main(): void {
  const readmeText = readFileSync(path.join(REPO_ROOT, 'plan', 'README.md'), 'utf8');
  const phaseStatus = parsePhaseStatus(readmeText);

  let failed = false;

  for (const guard of GUARDS) {
    const files = resolveFiles(guard.globs);
    if (files.length > 0) {
      console.log(`guard ${guard.name}: ${files.length} files matched`);
      continue;
    }

    const status = guard.activatesIn ? phaseStatus.get(guard.activatesIn) : undefined;
    const activatesInOk =
      guard.activatesIn !== undefined && status !== undefined && status !== 'done';

    if (activatesInOk) {
      console.log(
        `guard ${guard.name}: 0 files matched — activatesIn ${guard.activatesIn} (${status})`,
      );
    } else {
      console.log(
        `guard ${guard.name}: 0 files matched — activatesIn ${guard.activatesIn ?? 'none'} (${status ?? 'unknown'})`,
      );
      console.error(`guard matched zero files: ${guard.name}`);
      failed = true;
    }
  }

  console.log(`registry: ${GUARDS.length} guards registered`);

  if (failed) {
    process.exit(1);
  }
}

main();

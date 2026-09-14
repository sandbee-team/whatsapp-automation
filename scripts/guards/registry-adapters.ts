import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  runCheckBoxMemory,
  checkBoxMemoryBudget,
  BoxMemoryBudgetExceededError,
} from '../check-box-memory.js';
import { runCheckNoInsecureTls } from '../check-no-insecure-tls.js';
import { REPO_ROOT } from './scan-config.js';
import type { GuardResult } from './scan-config.js';

/**
 * registry-adapters.ts (split out of registry.ts, P20 Unit U3, to stay under
 * the 300-line cap) - the two guard adapters whose underlying checker
 * doesn't already match the registry's plain `Guard.run(files)` contract.
 */

/**
 * `check-box-memory.ts` reads a compose file directly (see its own header)
 * and THROWS `BoxMemoryBudgetExceededError` rather than returning
 * violations - this adapter converts that into the registry's `GuardResult`
 * shape so it fits the same `Guard.run(files)` contract as every other entry.
 */
export function runBoxMemoryGuard(): GuardResult {
  const { workers } = runCheckBoxMemory();
  try {
    checkBoxMemoryBudget(workers, {});
  } catch (err) {
    if (err instanceof BoxMemoryBudgetExceededError) {
      return {
        violations: [{ file: 'infra/compose/docker-compose.dev.yml', message: err.message }],
        filesScanned: workers.length,
      };
    }
    throw err;
  }
  return { violations: [], filesScanned: workers.length };
}

/** `check-no-insecure-tls.ts` takes already-read `SourceFile[]`, not a path list - this adapter reads the resolved files before delegating (same adapter idea as `runBoxMemoryGuard` above). */
export function runInsecureTlsGuard(files: string[]): GuardResult {
  const sources = files.map((relativePath) => ({
    path: relativePath,
    content: readFileSync(path.join(REPO_ROOT, relativePath), 'utf8'),
  }));
  return { ...runCheckNoInsecureTls(sources), filesScanned: sources.length };
}

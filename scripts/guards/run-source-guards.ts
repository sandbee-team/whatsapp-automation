import { readFileSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './scan-config.js';
import type { GuardResult } from './scan-config.js';
import { runCheckNoRawHex } from '../check-no-raw-hex.js';
import { runCheckUiClientDirective } from '../check-ui-client-directive.js';

/**
 * Adapters from the registry's `run(files: string[])` shape (relative repo
 * paths) to the `{ path, content }[]` shape `runCheckNoRawHex`/
 * `runCheckUiClientDirective` (P05 step 3) actually take - kept out of
 * `registry.ts` to stay under its own `max-lines` lint budget.
 */
function readAsSourceFiles(files: string[]): { path: string; content: string }[] {
  return files.map((relativePath) => ({
    path: relativePath,
    content: readFileSync(path.join(REPO_ROOT, relativePath), 'utf8'),
  }));
}

export function runNoRawHexGuard(files: string[]): GuardResult {
  return runCheckNoRawHex(readAsSourceFiles(files));
}

export function runUiClientDirectiveGuard(files: string[]): GuardResult {
  return runCheckUiClientDirective(readAsSourceFiles(files));
}

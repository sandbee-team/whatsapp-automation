import { runSemgrepGuard, runTrivyGuard, runSecretScanGuard } from './security-scan-runner.js';
import {
  SEMGREP_GUARD_GLOBS,
  TRIVY_GUARD_GLOBS,
  SECRET_SCAN_GUARD_GLOBS,
} from './security-scan-guards-globs.js';
import type { GuardResult } from './scan-config.js';

/**
 * security-scan-guards.ts (P29a launch-hardening Unit U1) - the three
 * `security:*` guard registrations, split out of `registry.ts` to stay
 * under its `max-lines: 300` cap (same discipline as
 * `registry-adapters.ts`). The `Guard` shape is repeated structurally
 * (rather than imported from `registry.ts`) so this leaf module never
 * imports back from the file that imports it - `registry.ts` is not a leaf
 * (see `scan-config.ts`'s header on why the cycle matters here).
 */
interface SecurityGuard {
  name: string;
  globs: string[];
  run(files: string[]): Promise<GuardResult> | GuardResult;
}

export const SECURITY_SCAN_GUARDS: SecurityGuard[] = [
  {
    name: 'security:semgrep',
    globs: SEMGREP_GUARD_GLOBS,
    run: runSemgrepGuard,
  },
  {
    name: 'security:trivy',
    globs: TRIVY_GUARD_GLOBS,
    run: runTrivyGuard,
  },
  {
    name: 'security:secret-scan',
    globs: SECRET_SCAN_GUARD_GLOBS,
    run: runSecretScanGuard,
  },
];

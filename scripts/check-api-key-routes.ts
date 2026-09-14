import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, resolveFiles } from './guards/scan-config.js';
import type { GuardResult, GuardViolation } from './guards/scan-config.js';

/**
 * check-api-key-routes.ts (go-live U3) - the widening guard for
 * `route-policy.ts`'s `session_or_api_key` policy: a bearer authenticating
 * with an API key is a wider attack surface than a logged-in session (no
 * MFA claim to check, no session_id, entitlement inherited from a possibly
 * long-departed creator - see `guards.ts#requireCanSendForPrincipal`'s own
 * doc comment), so this policy value is deliberately allow-listed to exactly
 * the routes it was built for (originally one - `POST /v1/messages` - joined
 * by `POST /v1/media` in P34 U-upload for the same reason: an API caller
 * that may create a message may also upload the media it references). Any
 * OTHER `registerRoute` call site declaring `policy: 'session_or_api_key'`
 * fails this guard, naming the offending route - the same "allow-list + fail
 * the build" shape as `check-no-direct-publish.ts`'s own allowed-paths list.
 *
 * Matches a `registerRoute(...)` call's `path:`/`policy:` config fields via
 * a bounded, per-call-site scan (never a whole-file substring match): a
 * config object's `path` and `policy` fields can appear in any order, so
 * this looks for the two fields inside each `{ ... }` call argument in
 * isolation, rather than requiring one fixed field order.
 */

/** The one route this policy is built for today. Widen this list only with an explicit reviewed change - see the module doc comment. */
// P34 U-upload (ADR 0052 accepted scope): an API-key caller may upload media
// the same way it may create a message - `POST /v1/media` is the second and,
// as of this dispatch, LAST route on this allow-list.
export const API_KEY_ROUTES_ALLOWED_URLS: readonly string[] = ['/v1/messages', '/v1/media'];

/** The backend source tree - the only place `registerRoute` is ever called. */
export const API_KEY_ROUTES_GLOBS = ['app/backend/src/**/*.ts'];

export interface SourceFile {
  path: string;
  content: string;
}

const REGISTER_ROUTE_CALL_PATTERN = /registerRoute\s*\(([\s\S]*?)\)\s*;/g;
const PATH_FIELD_PATTERN = /\bpath\s*:\s*['"`]([^'"`]+)['"`]/;
const POLICY_FIELD_PATTERN = /\bpolicy\s*:\s*['"`]([^'"`]+)['"`]/;

/** Pure scan over already-read source texts - no filesystem access. */
export function scanApiKeyRoutes(
  files: SourceFile[],
  allowedUrls: readonly string[],
): GuardViolation[] {
  const violations: GuardViolation[] = [];

  for (const file of files) {
    for (const match of file.content.matchAll(REGISTER_ROUTE_CALL_PATTERN)) {
      const callBody = match[1] ?? '';
      const policyMatch = POLICY_FIELD_PATTERN.exec(callBody);
      if (!policyMatch || policyMatch[1] !== 'session_or_api_key') {
        continue;
      }
      const pathMatch = PATH_FIELD_PATTERN.exec(callBody);
      const url = pathMatch?.[1] ?? '(unknown path)';
      if (allowedUrls.includes(url)) {
        continue;
      }
      violations.push({
        file: file.path,
        line: file.content.slice(0, match.index).split('\n').length,
        message: `route "${url}" declares policy 'session_or_api_key' but is not on the allow-list (${allowedUrls.join(', ')}) - see check-api-key-routes.ts`,
      });
    }
  }

  return violations;
}

function readSourceFiles(): SourceFile[] {
  return resolveFiles(API_KEY_ROUTES_GLOBS).map((relativePath) => ({
    path: relativePath,
    content: readFileSync(path.join(REPO_ROOT, relativePath), 'utf8'),
  }));
}

export function runCheckApiKeyRoutes(): GuardResult {
  const files = readSourceFiles();
  const violations = scanApiKeyRoutes(files, API_KEY_ROUTES_ALLOWED_URLS);
  return { violations, filesScanned: files.length };
}

function main(): void {
  const result = runCheckApiKeyRoutes();

  if (result.violations.length > 0) {
    for (const violation of result.violations) {
      const location =
        violation.line === undefined
          ? violation.file
          : `${violation.file}:${String(violation.line)}`;
      console.error(`check-api-key-routes: ${location} - ${violation.message}`);
    }
    process.exit(1);
  }

  console.log(
    `check-api-key-routes: ${String(result.filesScanned ?? 0)} files scanned, 0 violations`,
  );
}

const isMain =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
  main();
}

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, resolveFiles } from './guards/scan-config.js';
import type { GuardResult, GuardViolation } from './guards/scan-config.js';
import { buildGraph, traverseModuleGraph } from './guards/module-graph.js';
import type { ModuleFile } from './guards/module-graph.js';

/**
 * check-placement-neutrality.ts (P09 Unit U5, step 8, ADR 0018 S6) - "host/
 * worker assignment is capacity-only. engine/fleet/discovery.ts and
 * engine/fleet/shed.ts may not import instance health, pause or restriction
 * history, or any IP-diversity notion." (ADR 0018 S6, verbatim.)
 *
 * IMPORT-GRAPH based, NOT string-based (CRITICAL, phase-pinned requirement):
 * from the two roots, walks the transitive RELATIVE-import graph (see
 * `module-graph.ts`) and fails only when a real import EDGE reaches a module
 * whose repo-relative path starts with one of `BANNED_PLACEMENT_PATH_PREFIXES`
 * below. The SQL literal `health_state` inside `discovery.ts`/`db/queries/*.sql`
 * is legal link-liveness filtering (see discovery.ts's own header comment)
 * and must NOT trip this guard - there is no string/text scan here at all,
 * only resolved module-graph edges.
 *
 * `app/backend/src/modules/instances/**` is where WaHealth/PauseReason/
 * health-state-transition logic actually lives today (see
 * `modules/instances/service.ts`'s `HEALTH_TO_AUDIT_ACTION`/
 * `USER_ACTION_REASON_TO_PAUSE_REASON` - there is no separate
 * `modules/health/**` tree in this repo yet). There is no IP/proxy/egress
 * module anywhere in the repo (confirmed by search) - the ban on that
 * category is enforced by construction: it has nothing to match today, and
 * this guard will start rejecting it the moment such a module's path is
 * added to the banned-prefix list below.
 */

export const PLACEMENT_NEUTRALITY_ROOTS = [
  'app/backend/src/engine/fleet/discovery.ts',
  'app/backend/src/engine/fleet/shed.ts',
] as const;

export const PLACEMENT_NEUTRALITY_GLOBS = ['app/backend/src/**/*.{ts,tsx}'];

/**
 * ADR 0018 S6 banned-path prefixes, in ONE exported constant (per the phase
 * spec). `modules/instances/**` is today's home of WaHealth/PauseReason/
 * health-state-transition + restriction-history logic (there is no separate
 * `modules/health/**` tree yet - if one is split out later, add its prefix
 * here too, never remove this one). The `ip-`/`proxy`/`egress` prefixes have
 * no real module to match yet (there is none in the repo) - they exist so
 * this guard rejects one the instant it is added, never after.
 */
export const BANNED_PLACEMENT_PATH_PREFIXES: readonly string[] = [
  'app/backend/src/modules/health/',
  'app/backend/src/modules/instances/',
  'app/backend/src/modules/pause/',
  'app/backend/src/modules/restriction/',
  'app/backend/src/modules/ip-diversity/',
  'app/backend/src/modules/proxy/',
  'app/backend/src/modules/egress/',
];

function readSourceFiles(): ModuleFile[] {
  return resolveFiles(PLACEMENT_NEUTRALITY_GLOBS).map((relativePath) => ({
    path: relativePath,
    content: readFileSync(path.join(REPO_ROOT, relativePath), 'utf8'),
  }));
}

/** Pure core - no filesystem access, no string/text scanning: resolved import-graph edges only. */
export function scanPlacementNeutrality(
  files: readonly ModuleFile[],
  roots: readonly string[],
): GuardViolation[] {
  const violations: GuardViolation[] = [];
  const graph = buildGraph(files);
  const presentRoots = roots.filter((root) => graph.has(root));
  const { visited } = traverseModuleGraph(presentRoots, graph);

  for (const nodePath of visited) {
    const bannedPrefix = BANNED_PLACEMENT_PATH_PREFIXES.find((prefix) =>
      nodePath.startsWith(prefix),
    );
    if (bannedPrefix === undefined) continue;
    if ((roots as readonly string[]).includes(nodePath)) continue;

    violations.push({
      file: nodePath,
      message: `placement neutrality violation (ADR 0018 S6): "${nodePath}" is reachable from discovery.ts/shed.ts and falls under the banned prefix "${bannedPrefix}" - host/worker assignment is capacity-only, never health/pause/restriction/IP-diversity aware`,
    });
  }

  return violations;
}

export function runCheckPlacementNeutrality(): GuardResult {
  const files = readSourceFiles();
  return {
    violations: scanPlacementNeutrality(files, PLACEMENT_NEUTRALITY_ROOTS),
    filesScanned: files.length,
  };
}

function main(): void {
  const result = runCheckPlacementNeutrality();

  if (result.violations.length > 0) {
    for (const violation of result.violations) {
      console.error(`placement-neutrality: ${violation.file} - ${violation.message}`);
    }
    process.exit(1);
  }

  console.log(
    `placement-neutrality: ${String(result.filesScanned ?? 0)} files scanned, 0 violations`,
  );
}

const isMain =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
  main();
}

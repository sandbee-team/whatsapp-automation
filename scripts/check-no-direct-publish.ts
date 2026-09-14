import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, resolveFiles } from './guards/scan-config.js';
import type { GuardResult, GuardViolation } from './guards/scan-config.js';

/**
 * check-no-direct-publish.ts (P15 U2, step 4; WIDENED P15 C1 FIX F8 / MAJ-6)
 * - the publish-boundary guard. ADR 0010: "Business change + outbox row
 * commit in one transaction; the relay role publishes and marks them.
 * Nothing is ever published from inside a business transaction."
 * `emit(tx, ...)` (`modules/events/emit.ts`) is the ONE sanctioned way a
 * business module writes an outbox row; this guard is the mechanical proof
 * that a direct call into the realtime hub's publish method, OR the
 * cross-process redis-bridge publisher's own equivalent method (see
 * `PUBLISH_CALL_PATTERN`/`WIDENED_PUBLISH_CALL_PATTERN` below for the exact
 * matched shapes), is never made from anywhere else.
 *
 * NOTE ON THIS FILE'S OWN PROSE: every call-shape example below is written
 * with a deliberate space before the method name (e.g. "hub DOT publish")
 * rather than the real dotted call syntax, specifically so this guard's own
 * source file is never accidentally caught by the very patterns it defines
 * when the repo tree scans itself (`NO_DIRECT_PUBLISH_GLOBS` includes
 * `scripts/**`).
 *
 * WIDENING RATIONALE (F8): the original pattern matched only one specific
 * literal call text, hub DOT publish - the three live production bypass
 * call sites (`engine/pacing/warmup-evaluator.ts`, `engine/session/
 * runner-connection-update.ts`, `engine/session/runner-disconnect.ts`) all
 * call a DIFFERENTLY-NAMED local dependency's own method (a
 * `PacingEvaluatorPublish`/equivalent-shaped function, never named `hub`),
 * and the sanctioned QR path (`roles/session-worker.ts`) calls its own local
 * `publisher` variable's method, where that variable is built by the
 * redis-bridge module's publisher factory - none of these match the
 * original literal pattern at all. The widened check flags ANY
 * `<identifier> DOT publish(...)` call (never just that one literal
 * identifier) in a file whose own import list reaches the redis-bridge
 * module's publisher factory/type - deliberately narrow to files that
 * actually import a publisher-shaped value (never flags an unrelated
 * publish-shaped call on some other pub/sub API with no such import), and
 * never flags the redis-bridge module itself (on the allow-list - its OWN
 * internal Redis client call is the actual wire call, not a bypass).
 *
 * Allowed call sites, exactly:
 *   - `app/backend/src/modules/realtime/redis-bridge.ts` - the cross-process
 *     TRANSPORT (P08): its subscriber re-publishes an already-validated
 *     frame into the in-process hub on behalf of the worker-side publisher,
 *     and its own internal Redis client call IS the actual wire call.
 *   - `app/backend/src/roles/relay.ts` - the P15 relay role (U4) - the only
 *     PRODUCTION business-event publisher, always reading already-committed,
 *     already-durable outbox rows.
 *   - `app/backend/src/roles/session-worker.ts` - the SANCTIONED
 *     `instance.qr` direct leg (`emit()` rejects that type unconditionally -
 *     a QR is a bearer credential and never enters the outbox).
 *   - `app/backend/src/engine/pacing/warmup-evaluator.ts`,
 *     `app/backend/src/engine/session/runner-connection-update.ts`,
 *     `app/backend/src/engine/session/runner-disconnect.ts` - PRE-OUTBOX
 *     call sites recorded here as an EXPLICIT, commented exemption (P15 C1
 *     MAJ-6): they own `instance.pacing_changed`/`instance.health_changed`
 *     writes today via an injected `publish` port that is currently wired to
 *     a no-op (P17 wires the real publisher) - migrate to `emit(tx, ...)` in
 *     P16 when health/pacing own their own outbox writes. NOT migrated by
 *     this fix (out of scope, recorded as a carried note).
 *   - any test/test-support file (`.test.ts`, `.integration.test.ts`, or a
 *     path under `__test-support__/`/`__tests__/`) - test doubles legitimately
 *     construct a hub/publisher and call its publish method directly to
 *     assert behaviour in isolation from the outbox/relay.
 *
 * `instance.qr` keeps its existing direct worker -> redis-bridge leg
 * (never the outbox - see `emit.ts`'s own rejection of that type), so
 * `redis-bridge.ts`/`session-worker.ts` staying on the allow-list is
 * intentional, not a hole.
 */

const PUBLISH_CALL_PATTERN = /\bhub\.publish\s*\(/;

/** Any `<identifier>.publish(` call - the widened (F8) pattern, scoped by `isPublisherShapedFile` below to files that actually import a realtime publisher-shaped value. Deliberately excludes a bare `redis.publish(` receiver (the bridge's own internal Redis client call - see the module doc comment). */
const WIDENED_PUBLISH_CALL_PATTERN = /\b(?!redis\.)[A-Za-z_$][\w$]*\.publish(?:Batch)?\s*\(/;

/** A file imports the redis-bridge publisher factory/type - the widened pattern only applies here (never to an unrelated `.publish(` call on some other pub/sub API). */
const REDIS_BRIDGE_PUBLISHER_IMPORT_PATTERN =
  /\b(?:createRedisRealtimePublisher|RedisRealtimePublisher)\b/;

/** The exact allow-list - see the module doc comment above for each entry's rationale. */
export const NO_DIRECT_PUBLISH_ALLOWED_PATHS = [
  'app/backend/src/modules/realtime/redis-bridge.ts',
  'app/backend/src/roles/relay.ts',
  'app/backend/src/roles/session-worker.ts',
  // Pre-outbox call sites, migrate to emit(tx,...) in P16 (health/pacing own
  // these writes); exemption recorded P15 C1 MAJ-6.
  'app/backend/src/engine/pacing/warmup-evaluator.ts',
  'app/backend/src/engine/session/runner-connection-update.ts',
  'app/backend/src/engine/session/runner-disconnect.ts',
];

const TEST_FILE_PATTERN = /\.test\.ts$/;
const TEST_SUPPORT_DIR_PATTERN = /__test-support__\/|__tests__\//;

function isAllowed(filePath: string, allowedPaths: readonly string[]): boolean {
  if (allowedPaths.includes(filePath)) return true;
  if (TEST_FILE_PATTERN.test(filePath)) return true;
  if (TEST_SUPPORT_DIR_PATTERN.test(filePath)) return true;
  return false;
}

/** The backend source trees - business code that could reach for a direct hub publish call. */
export const NO_DIRECT_PUBLISH_GLOBS = [
  'app/backend/src/**/*.ts',
  'admin/backend/src/**/*.ts',
  'scripts/**/*.ts',
];

export interface SourceFile {
  path: string;
  content: string;
}

/** Pure scan over already-read source texts - no filesystem access. */
export function scanNoDirectPublish(
  files: SourceFile[],
  allowedPaths: readonly string[],
): GuardViolation[] {
  const violations: GuardViolation[] = [];

  for (const file of files) {
    if (isAllowed(file.path, allowedPaths)) continue;

    // F8 widening: the `<identifier>.publish(` pattern only applies to
    // files that actually import the redis-bridge publisher factory/type -
    // never a false positive on an unrelated pub/sub-shaped `.publish(`
    // call elsewhere in the tree.
    const isPublisherShapedFile = REDIS_BRIDGE_PUBLISHER_IMPORT_PATTERN.test(file.content);

    const lines = file.content.split('\n');
    lines.forEach((line, index) => {
      if (PUBLISH_CALL_PATTERN.test(line)) {
        violations.push({
          file: file.path,
          line: index + 1,
          message:
            'direct hub publish call outside the allowed transport/relay files - business code must call emit(tx, ...) and let the relay publish (ADR 0010)',
        });
        return;
      }
      if (isPublisherShapedFile && WIDENED_PUBLISH_CALL_PATTERN.test(line)) {
        violations.push({
          file: file.path,
          line: index + 1,
          message:
            'direct realtime-publisher method call outside the allowed transport/relay files - business code must call emit(tx, ...) and let the relay publish (ADR 0010)',
        });
      }
    });
  }

  return violations;
}

function readSourceFiles(): SourceFile[] {
  return resolveFiles(NO_DIRECT_PUBLISH_GLOBS).map((relativePath) => ({
    path: relativePath,
    content: readFileSync(path.join(REPO_ROOT, relativePath), 'utf8'),
  }));
}

export function runCheckNoDirectPublish(): GuardResult {
  const files = readSourceFiles();
  const violations = scanNoDirectPublish(files, NO_DIRECT_PUBLISH_ALLOWED_PATHS);
  return { violations, filesScanned: files.length };
}

function main(): void {
  const result = runCheckNoDirectPublish();

  if (result.violations.length > 0) {
    for (const violation of result.violations) {
      const location =
        violation.line === undefined
          ? violation.file
          : `${violation.file}:${String(violation.line)}`;
      console.error(`check-no-direct-publish: ${location} - ${violation.message}`);
    }
    process.exit(1);
  }

  console.log(
    `check-no-direct-publish: ${String(result.filesScanned ?? 0)} files scanned, 0 violations`,
  );
}

const isMain =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
  main();
}

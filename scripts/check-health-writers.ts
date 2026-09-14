import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, resolveFiles } from './guards/scan-config.js';
import type { GuardResult, GuardViolation } from './guards/scan-config.js';
import {
  FORBIDDEN_HEALTH_BAND_MESSAGE,
  FORBIDDEN_HEALTH_STATE_MESSAGE,
  hasHealthBandWrite,
  hasHealthStateWrite,
  lineOfIndex,
  literalSpans,
} from './guards/health-writers-lib.js';
import type { SourceFile } from './guards/health-writers-lib.js';

/**
 * check-health-writers.ts (P16 Unit E, step 10) - the single-writer guard for
 * the two health-state authorities (core invariant 3: idempotency at the
 * storage layer via ONE writer, never a second uncoordinated authority over
 * the same state). Mirrors check-single-reserve.ts's structure: `.sql` files
 * scanned whole-content (except the pinned allow-list paths), `.ts`/`.tsx`
 * scanned per string/template-literal span.
 *
 * PINNED ALLOW-LISTS (discovered by grepping every real writer in the repo
 * at the time this guard was written - a NEW writer anywhere else turns
 * this guard red):
 *
 *   `whatsapp_instances.health_state`:
 *     - app/backend/src/modules/pacing/health/hard-signal-pause.ts
 *     - app/backend/src/modules/pacing/health/human-resume.ts
 *     - app/backend/src/engine/queue/result-pause.ts (existing PAUSE_INSTANCE
 *       writer, pre-dates this phase)
 *     - db/queries/instance-mark-logged-out.sql
 *     - db/queries/instance-mark-linked-connected.sql
 *     - db/queries/instance-apply-transition.sql
 *     - db/queries/instance-mark-infra-unavailable.sql
 *
 *   `instance_pacing_state.health_score` / `.health_band`:
 *     - app/backend/src/modules/pacing/health/HealthEvaluator.ts
 *     - app/backend/src/engine/pacing/config-service-warmup-write.ts
 *       (existing config-service `eff_*`/health_band rewrite writer,
 *       pre-dates this phase - apply-band.ts/fast-lane.ts route THROUGH this
 *       one function, never write the column a second time themselves)
 */

export const HEALTH_STATE_WRITER_ALLOW_LIST: readonly string[] = [
  'app/backend/src/modules/pacing/health/hard-signal-pause.ts',
  'app/backend/src/modules/pacing/health/human-resume.ts',
  // P28 U3b: the STAFF-initiated pause (pause_reason='admin_action'); a separate writer from hard-signal-pause.ts because its needs_user_action/evidence/notify shape is the opposite - see staff-pause.ts's own header.
  'app/backend/src/modules/pacing/health/staff-pause.ts',
  'app/backend/src/engine/queue/result-pause.ts',
  'db/queries/instance-mark-logged-out.sql',
  'db/queries/instance-mark-linked-connected.sql',
  'db/queries/instance-apply-transition.sql',
  'db/queries/instance-mark-infra-unavailable.sql',
];

export const HEALTH_BAND_WRITER_ALLOW_LIST: readonly string[] = [
  'app/backend/src/modules/pacing/health/HealthEvaluator.ts',
  'app/backend/src/engine/pacing/config-service-warmup-write.ts',
];

/** Same five ADR 0014 source trees (including db/tests, db/schema), every raw `.sql` file, plus `scripts/` - same universe as check-single-reserve.ts/check-no-auto-requeue.ts. */
export const HEALTH_WRITERS_GLOBS = [
  'app/**/src/**/*.{ts,tsx}',
  'admin/**/src/**/*.{ts,tsx}',
  'website/src/**/*.{ts,tsx}',
  'packages/*/src/**/*.{ts,tsx}',
  'db/src/**/*.{ts,tsx}',
  'db/tests/**/*.{ts,tsx}',
  'db/schema/**/*.{ts,tsx}',
  'db/queries/**/*.sql',
  'db/migrations/**/*.sql',
  'db/seeds/**/*.sql',
  'db/tests/**/*.sql',
  'app/**/*.sql',
  'admin/**/*.sql',
  'infra/**/*.sql',
  'packages/**/*.sql',
  'website/**/*.sql',
  'scripts/**/*.ts',
];

const TEST_FILE_PATTERN = /(^|\/)(__tests__|tests?)\/|\.(test|spec)\.tsx?$/;

/** Pure core - no filesystem access. Test files are exempt (same reasoning as check-no-auto-requeue.ts's own TEST_FILE_PATTERN exemption: a test proving the invariant is evidence FOR it, not a second production path). */
export function scanHealthWriters(files: SourceFile[]): GuardViolation[] {
  const violations: GuardViolation[] = [];

  for (const file of files) {
    if (TEST_FILE_PATTERN.test(file.path)) continue;

    if (file.path.endsWith('.sql')) {
      if (
        !HEALTH_STATE_WRITER_ALLOW_LIST.includes(file.path) &&
        hasHealthStateWrite(file.content)
      ) {
        violations.push({ file: file.path, message: FORBIDDEN_HEALTH_STATE_MESSAGE });
      }
      if (!HEALTH_BAND_WRITER_ALLOW_LIST.includes(file.path) && hasHealthBandWrite(file.content)) {
        violations.push({ file: file.path, message: FORBIDDEN_HEALTH_BAND_MESSAGE });
      }
      continue;
    }

    const isHealthStateAllowed = HEALTH_STATE_WRITER_ALLOW_LIST.includes(file.path);
    const isHealthBandAllowed = HEALTH_BAND_WRITER_ALLOW_LIST.includes(file.path);
    if (isHealthStateAllowed && isHealthBandAllowed) continue;

    for (const span of literalSpans(file.content)) {
      if (!isHealthStateAllowed && hasHealthStateWrite(span.text)) {
        violations.push({
          file: file.path,
          line: lineOfIndex(file.content, span.index),
          message: FORBIDDEN_HEALTH_STATE_MESSAGE,
        });
      }
      if (!isHealthBandAllowed && hasHealthBandWrite(span.text)) {
        violations.push({
          file: file.path,
          line: lineOfIndex(file.content, span.index),
          message: FORBIDDEN_HEALTH_BAND_MESSAGE,
        });
      }
    }
  }

  return violations;
}

function readSourceFiles(): SourceFile[] {
  return resolveFiles(HEALTH_WRITERS_GLOBS).map((relativePath) => ({
    path: relativePath,
    content: readFileSync(path.join(REPO_ROOT, relativePath), 'utf8'),
  }));
}

export function runCheckHealthWriters(): GuardResult {
  const files = readSourceFiles();
  return { violations: scanHealthWriters(files), filesScanned: files.length };
}

function main(): void {
  const files = readSourceFiles();
  const violations = scanHealthWriters(files);

  if (violations.length > 0) {
    for (const violation of violations) {
      console.error(
        `check-health-writers: ${violation.file}:${String(violation.line ?? '?')} - ${violation.message}`,
      );
    }
    console.log(
      `check-health-writers: ${String(files.length)} files scanned, ${String(violations.length)} violation(s)`,
    );
    process.exit(1);
  }

  console.log(`check-health-writers: ${String(files.length)} files scanned, 0 violations`);
}

const isMain =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
  main();
}

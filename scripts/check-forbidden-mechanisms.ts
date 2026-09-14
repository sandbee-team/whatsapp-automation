import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, SCAN_GLOBS, resolveFiles } from './guards/scan-config.js';
import type { GuardResult, GuardViolation } from './guards/scan-config.js';

/**
 * check-forbidden-mechanisms.ts (P16 Unit D, step 8; design test 30
 * `no_forbidden_mechanism_exists`, extended for this phase) - the mechanical
 * enforcement of core invariant 6 (no provider-evasion mechanisms, ever) and
 * design §7's FORBIDDEN list: automatic number rotation, fake identities,
 * proxy tricks, or any mechanism to evade a provider restriction.
 *
 * TWO CLAUSES:
 *
 * (a) FORBIDDEN IDENTIFIER/STRING SCAN - a case-insensitive match of any
 *     identifier or string naming a known evasion mechanism (number
 *     rotation, proxy pools, fingerprint/device spoofing, an automatic
 *     resume, a pacing bypass, or a failover-number scheme) anywhere in the
 *     shipped tree. The pattern is built by `.join()`/concatenation, never
 *     as one contiguous literal, for the same reason `check-copy.ts`'s own
 *     product-name tokens are - this file is itself scanned by
 *     `FORBIDDEN_GLOBS` (`scripts/**\/*.ts`), and a literal match here would
 *     make this guard trip on its own source.
 *
 * (b) PAUSED-EXIT ACTOR ASSERTION - the ONLY file in the shipped tree
 *     allowed to write `whatsapp_instances.health_state` FROM `'paused'` to
 *     a sending-capable state is `modules/pacing/health/human-resume.ts`,
 *     and that file's exported `humanResume` must type its `actor`
 *     parameter as `UserActor` (never the broader `Actor` union) - a
 *     string-level assertion on the file's own source, matching this
 *     guard's own honest text-heuristic idiom (`no-auto-requeue-actor.ts`'s
 *     doc comment: "a best-effort ... scan, not a real parser" is the
 *     proportionate choice for a fail-safe/invariant guard whose target is
 *     a single named file, not an adversarial bypass).
 */

const FORBIDDEN_TOKENS = [
  'rotateNumber',
  'numberRotation',
  'proxyPool',
  'rotateProxy',
  'proxyscrape',
  'fingerprintSpoof',
  'deviceSpoof',
  'autoResume',
  'bypassPacing',
  'failoverNumber',
  // P24 groups-messaging Unit U2: WP never manages group MEMBERSHIP or
  // SETTINGS - a group is a place the account already is, and any of these
  // Baileys calls would make WP itself the actor adding/inviting/promoting/
  // configuring a group, which is out of scope for a fail-safe messaging
  // product and is the same class of "acting on the platform beyond sending"
  // this guard already bans for numbers/identities/proxies. `groupLeave`
  // (de-escalation, single call site) and `groupFetchAllParticipating`/
  // `groupMetadata` (read-only sync) are deliberately NOT banned.
  'groupParticipantsUpdate',
  'groupCreate',
  'groupInviteCode',
  'groupAcceptInvite',
  'groupAcceptInviteV4',
  'groupRevokeInvite',
  'groupRequestParticipantsUpdate',
  'groupRequestParticipantsList',
  'groupMemberAddMode',
  'groupJoinApprovalMode',
  'groupSettingUpdate',
  'groupUpdateSubject',
  'groupUpdateDescription',
  'groupToggleEphemeral',
].join('|');

export const FORBIDDEN_MECHANISM_PATTERN = new RegExp(`\\b(?:${FORBIDDEN_TOKENS})\\b`, 'i');

/** The ONE file allowed to take `health_state` out of `'paused'` (module doc, clause (b)). */
export const PAUSED_EXIT_WRITER_PATH = 'app/backend/src/modules/pacing/health/human-resume.ts';

/** The ADR 0014 shipped source tree, `.ts`/`.tsx`/`.sql` only (the surface a forbidden mechanism could actually ship in). */
export const FORBIDDEN_MECHANISM_GLOBS = SCAN_GLOBS.map((root) => `${root}/*.{ts,tsx,sql}`);

export interface SourceFile {
  path: string;
  content: string;
}

function lineOfIndex(content: string, index: number): number {
  return content.slice(0, index).split('\n').length;
}

/** This guard's own source is exempt from clause (a) - it IS the ban list (same principled exemption `check-copy.ts#BANNED_CLAIMS_EXEMPT_FILES` uses for itself). */
export const FORBIDDEN_MECHANISM_EXEMPT_FILES: readonly string[] = Object.freeze([
  'scripts/check-forbidden-mechanisms.ts',
]);

function scanForbiddenTokens(file: SourceFile): GuardViolation[] {
  if (FORBIDDEN_MECHANISM_EXEMPT_FILES.includes(file.path)) return [];

  const match = FORBIDDEN_MECHANISM_PATTERN.exec(file.content);
  if (!match) return [];

  return [
    {
      file: file.path,
      line: lineOfIndex(file.content, match.index),
      message: `forbidden mechanism identifier/string "${match[0]}" - core invariant 6 (no provider-evasion mechanisms, ever)`,
    },
  ];
}

/**
 * Clause (b): a `whatsapp_instances` write that sets `health_state` to a
 * value OTHER than `'paused'` while its own WHERE clause requires the
 * CURRENT row to be `health_state = 'paused'` - the shape every
 * paused-exit writer has (see `human-resume.ts`'s own UPDATE). Any file
 * matching this shape that is NOT `PAUSED_EXIT_WRITER_PATH` is a violation;
 * `PAUSED_EXIT_WRITER_PATH` itself must ALSO declare a `UserActor`-typed
 * `actor` parameter on its exported writer function, or it is flagged too
 * (the exemption covers "this file may leave paused", not "this file may do
 * so however it likes").
 */
const PAUSED_EXIT_WRITE_PATTERN =
  /UPDATE\s+whatsapp_instances\s+SET[\s\S]*?health_state\s*=\s*'(?!paused')\w+'[\s\S]*?WHERE[\s\S]*?health_state\s*=\s*'paused'/i;

const USER_ACTOR_PARAM_PATTERN = /actor\s*:\s*UserActor/;

function scanPausedExitWriters(file: SourceFile): GuardViolation[] {
  if (!PAUSED_EXIT_WRITE_PATTERN.test(file.content)) return [];

  if (file.path !== PAUSED_EXIT_WRITER_PATH) {
    return [
      {
        file: file.path,
        message:
          'forbidden mechanism: a paused-exit whatsapp_instances write outside human-resume.ts - ' +
          'only a real user actor may take health_state out of "paused" (core invariant 2/6)',
      },
    ];
  }

  if (!USER_ACTOR_PARAM_PATTERN.test(file.content)) {
    return [
      {
        file: file.path,
        message:
          'forbidden mechanism: human-resume.ts no longer types its actor parameter as UserActor - ' +
          'a paused-exit write must be structurally impossible without a real user actor',
      },
    ];
  }

  return [];
}

/** Pure core - no filesystem access. */
export function scanForbiddenMechanisms(files: SourceFile[]): GuardViolation[] {
  const violations: GuardViolation[] = [];
  for (const file of files) {
    violations.push(...scanForbiddenTokens(file));
    violations.push(...scanPausedExitWriters(file));
  }
  return violations;
}

function readSourceFiles(): SourceFile[] {
  return resolveFiles(FORBIDDEN_MECHANISM_GLOBS).map((relativePath) => ({
    path: relativePath,
    content: readFileSync(path.join(REPO_ROOT, relativePath), 'utf8'),
  }));
}

export function runCheckForbiddenMechanisms(): GuardResult {
  const files = readSourceFiles();
  return { violations: scanForbiddenMechanisms(files), filesScanned: files.length };
}

function main(): void {
  const files = readSourceFiles();
  const violations = scanForbiddenMechanisms(files);

  if (violations.length > 0) {
    for (const violation of violations) {
      const location =
        violation.line === undefined
          ? violation.file
          : `${violation.file}:${String(violation.line)}`;
      console.error(`check-forbidden-mechanisms: ${location} - ${violation.message}`);
    }
    console.log(
      `check-forbidden-mechanisms: ${String(files.length)} files scanned, ${String(violations.length)} violation(s)`,
    );
    process.exit(1);
  }

  console.log(`check-forbidden-mechanisms: ${String(files.length)} files scanned, 0 violations`);
}

const isMain =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
  main();
}

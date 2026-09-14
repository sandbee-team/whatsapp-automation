import type { GuardViolation } from './scan-config.js';
import type { SourceFile } from '../check-send-origin.js';

/**
 * send-origin-exempt-shape.ts (P14 Unit U7) - clause (c) of
 * `check-send-origin.ts`, split into its own sibling module purely for that
 * file's own `max-lines` cap (same established split idiom as
 * `session-worker-discovery-wiring.ts`). Two independent halves:
 *
 *   half 1 (`scanExemptOriginsLiteral`) - `packages/domain/src/pacing/
 *     send-origin.ts`'s `EXEMPT_ORIGINS` literal must parse to EXACTLY
 *     `{'system_reply','opt_out_confirmation'}`; a third member, a removal,
 *     or an unparseable literal is a violation.
 *   half 2 (`scanExemptOriginsHaveConstructionSite`) - at least one file
 *     under `modules/pacing/internal/` must reference the uppercase
 *     identifiers - an exempt set with no real construction site means this
 *     guard is matching nothing.
 *
 * Both halves only run when `send-origin.ts` itself is present in the
 * scanned file set - a caller feeding a small, unrelated fixture list (e.g.
 * `check-send-origin.test.ts`'s own clause (a)/(b) cases) is never claiming
 * to represent the whole repo tree, so it must not trip either half.
 */

const EXEMPT_ORIGIN_IDENTIFIERS = ['SYSTEM_REPLY', 'OPT_OUT_CONFIRMATION'] as const;
const PACING_INTERNAL_PATH = /modules\/pacing\/internal\//;
const EXEMPT_ORIGINS_DECL = /EXEMPT_ORIGINS\s*=\s*Object\.freeze\(\s*\[([^\]]*)\]/;
const STRING_LITERAL = /'([^']*)'|"([^"]*)"/g;
const EXPECTED_EXEMPT_ORIGINS: ReadonlySet<string> = new Set([
  'system_reply',
  'opt_out_confirmation',
]);

/** Strips a trailing `//` line comment - mirrors `check-send-origin.ts`'s own `codeOnly`, kept local to avoid a re-export just for this. */
function codeOnly(line: string): string {
  const index = line.indexOf('//');
  return index === -1 ? line : line.slice(0, index);
}

function findSendOriginFile(files: SourceFile[]): SourceFile | undefined {
  return files.find((file) => file.path.endsWith('pacing/send-origin.ts'));
}

export function scanExemptOriginsLiteral(files: SourceFile[]): GuardViolation[] {
  const target = findSendOriginFile(files);
  if (!target) {
    return [];
  }

  const declMatch = EXEMPT_ORIGINS_DECL.exec(target.content);
  if (!declMatch?.[1]) {
    return [
      {
        file: target.path,
        message:
          'EXEMPT_ORIGINS literal could not be parsed - expected exactly {"system_reply","opt_out_confirmation"}',
      },
    ];
  }

  const members = new Set<string>();
  for (const match of declMatch[1].matchAll(STRING_LITERAL)) {
    members.add(match[1] ?? match[2] ?? '');
  }

  const sameSize = members.size === EXPECTED_EXEMPT_ORIGINS.size;
  const sameMembers = sameSize && [...members].every((m) => EXPECTED_EXEMPT_ORIGINS.has(m));
  if (sameMembers) {
    return [];
  }

  return [
    {
      file: target.path,
      message: `EXEMPT_ORIGINS must be exactly {'system_reply','opt_out_confirmation'} - got {${[...members].map((m) => `'${m}'`).join(',')}}`,
    },
  ];
}

export function scanExemptOriginsHaveConstructionSite(files: SourceFile[]): GuardViolation[] {
  const target = findSendOriginFile(files);
  if (!target) {
    return [];
  }

  const hasRealSite = files.some(
    (file) =>
      PACING_INTERNAL_PATH.test(file.path) &&
      EXEMPT_ORIGIN_IDENTIFIERS.some((identifier) =>
        new RegExp(`\\b${identifier}\\b`).test(codeOnly(file.content)),
      ),
  );
  if (hasRealSite) {
    return [];
  }
  return [
    {
      file: target.path,
      message:
        'no file under modules/pacing/internal/ references SYSTEM_REPLY or OPT_OUT_CONFIRMATION - the exempt origin set has no real construction site',
    },
  ];
}

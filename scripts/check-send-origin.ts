import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, resolveFiles } from './guards/scan-config.js';
import type { GuardResult, GuardViolation } from './guards/scan-config.js';
import {
  scanExemptOriginsLiteral,
  scanExemptOriginsHaveConstructionSite,
} from './guards/send-origin-exempt-shape.js';

export { scanExemptOriginsLiteral, scanExemptOriginsHaveConstructionSite };

/**
 * check-send-origin.ts (P00 step 7) - the send-origin guard (core invariant
 * 6: no provider-evasion / no pacing-bypass surface). `SendOrigin` is how
 * pacing-exempt system messages (auto-replies, opt-out confirmations) are
 * distinguished from tenant sends; if tenant-reachable code could set
 * `origin`, a tenant could bypass pacing.
 *
 * Two independent clauses:
 * (a) exempt-origin references - `SYSTEM_REPLY` / `OPT_OUT_CONFIRMATION` may
 *     only be referenced under `modules/pacing/internal/`. Scanned over the
 *     BROAD tree (`SEND_ORIGIN_DTO_GLOBS`, the five ADR 0014 source trees) -
 *     the path-based skip for `modules/pacing/internal/` inside
 *     `scanExemptOriginReferences` is what provides the exemption, not a
 *     narrower file selection. `SEND_ORIGIN_EXEMPT_GLOBS` +
 *     `activatesIn: 'P14'` (registry.ts) exist purely as the registry
 *     activation marker for the not-yet-real `modules/pacing/internal/`
 *     path - they are not the scan universe for this clause.
 * (b) DTO origin-from-input - no Zod object schema, and no exported
 *     Input/DTO/Request/Body/Params type, may accept `origin` as a
 *     client-settable field, ever - including under modules/pacing/internal/
 *     itself: input DTOs never accept origin, there is no exemption. This
 *     clause is active today.
 * (c) exempt-set shape (P14 Unit U7) - `packages/domain/src/pacing/
 *     send-origin.ts`'s `EXEMPT_ORIGINS` literal must parse to EXACTLY
 *     `{'system_reply','opt_out_confirmation'}` (a third member, a removal,
 *     or an unparseable literal is a violation), AND at least one file under
 *     `modules/pacing/internal/` must reference the uppercase identifiers -
 *     an exempt set with no real construction site means this guard is
 *     matching nothing.
 */

const EXEMPT_ORIGIN_IDENTIFIERS = ['SYSTEM_REPLY', 'OPT_OUT_CONFIRMATION'] as const;
const PACING_INTERNAL_PATH = /modules\/pacing\/internal\//;
const ZOD_ORIGIN_KEY = /\borigin\s*\??\s*:\s*z\./;
const DTO_TYPE_NAME_SUFFIX = /(?:Input|DTO|Request|Body|Params)$/;
const EXPORTED_TYPE_DECL = /export\s+(?:interface|type)\s+(\w+)\b[^{]*\{/g;
const PROPERTY_KEY_ORIGIN = /\borigin\s*\??\s*:/;

/** The five ADR 0014 source trees' TS - the DTO clause's scan universe. */
export const SEND_ORIGIN_DTO_GLOBS = [
  'app/**/src/**/*.{ts,tsx}',
  'admin/**/src/**/*.{ts,tsx}',
  'website/src/**/*.{ts,tsx}',
  'packages/*/src/**/*.{ts,tsx}',
  'db/src/**/*.{ts,tsx}',
];

/** Nothing real exists here until P14 (the pacing module). */
export const SEND_ORIGIN_EXEMPT_GLOBS = ['app/backend/src/modules/**/*.{ts,tsx}'];

export interface SourceFile {
  path: string;
  content: string;
}

/** Strips a trailing `//` line comment - trivial, does not handle `//` inside strings. */
function codeOnly(line: string): string {
  const index = line.indexOf('//');
  return index === -1 ? line : line.slice(0, index);
}

function scanExemptOriginReferences(files: SourceFile[]): GuardViolation[] {
  const violations: GuardViolation[] = [];

  for (const file of files) {
    if (PACING_INTERNAL_PATH.test(file.path)) continue;

    const lines = file.content.split('\n');
    lines.forEach((line, index) => {
      const text = codeOnly(line);
      for (const identifier of EXEMPT_ORIGIN_IDENTIFIERS) {
        if (new RegExp(`\\b${identifier}\\b`).test(text)) {
          violations.push({
            file: file.path,
            line: index + 1,
            message: `exempt send-origin "${identifier}" referenced outside modules/pacing/internal/ - invariant 6 (no pacing-bypass surface)`,
          });
        }
      }
    });
  }

  return violations;
}

function findMatchingBraceEnd(content: string, openBraceIndex: number): number {
  let depth = 0;
  for (let i = openBraceIndex; i < content.length; i += 1) {
    if (content[i] === '{') depth += 1;
    else if (content[i] === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return content.length - 1;
}

function scanDtoOriginFromInput(files: SourceFile[]): GuardViolation[] {
  const violations: GuardViolation[] = [];

  for (const file of files) {
    const lines = file.content.split('\n');
    lines.forEach((line, index) => {
      if (ZOD_ORIGIN_KEY.test(line)) {
        violations.push({
          file: file.path,
          line: index + 1,
          message:
            'DTO schema accepts "origin" as a client-input field (z.object key) - pacing origin must never be client-settable',
        });
      }
    });

    const pattern = new RegExp(EXPORTED_TYPE_DECL.source, 'g');
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(file.content)) !== null) {
      const typeName = match[1];
      if (typeName === undefined || !DTO_TYPE_NAME_SUFFIX.test(typeName)) continue;

      const openBrace = file.content.indexOf('{', match.index);
      if (openBrace === -1) continue;
      const closeBrace = findMatchingBraceEnd(file.content, openBrace);
      const block = file.content.slice(openBrace, closeBrace + 1);

      if (PROPERTY_KEY_ORIGIN.test(block)) {
        const line = file.content.slice(0, openBrace).split('\n').length;
        violations.push({
          file: file.path,
          line,
          message: `exported type "${typeName}" has an "origin" property - pacing origin must never be client-settable`,
        });
      }
    }
  }

  return violations;
}

/**
 * Pure scan over already-read source texts - no filesystem access. Runs all
 * clauses together (clause (c) lives in `./guards/send-origin-exempt-
 * shape.js`, split out for max-lines - see that module's own doc); callers
 * that only care about one clause can filter the result by file path
 * (clause (a) is exempt-path-gated, clauses (b)/(c) are not).
 */
export function scanSendOrigin(files: SourceFile[]): GuardViolation[] {
  return [
    ...scanExemptOriginReferences(files),
    ...scanDtoOriginFromInput(files),
    ...scanExemptOriginsLiteral(files),
    ...scanExemptOriginsHaveConstructionSite(files),
  ];
}

function readSourceFiles(globs: string[]): SourceFile[] {
  return resolveFiles(globs).map((relativePath) => ({
    path: relativePath,
    content: readFileSync(path.join(REPO_ROOT, relativePath), 'utf8'),
  }));
}

/** Registry-facing run() - full scan (both clauses) over the DTO clause's universe. */
export function runCheckSendOrigin(): GuardResult {
  const files = readSourceFiles(SEND_ORIGIN_DTO_GLOBS);
  return { violations: scanSendOrigin(files) };
}

function main(): void {
  const dtoFiles = readSourceFiles(SEND_ORIGIN_DTO_GLOBS);

  const dtoViolations = scanDtoOriginFromInput(dtoFiles);
  // Broad-tree scan (CRITICAL 2): the exempt-origin clause runs over the
  // same file set as the DTO clause - scanExemptOriginReferences's own
  // modules/pacing/internal/ path skip is what provides the exemption, not
  // a narrower file selection. SEND_ORIGIN_EXEMPT_GLOBS/activatesIn P14
  // remain purely the registry activation marker (see registry.ts).
  const exemptViolations = scanExemptOriginReferences(dtoFiles);

  if (exemptViolations.length > 0) {
    for (const violation of exemptViolations) {
      console.error(
        `send-origin: ${violation.file}:${String(violation.line)} - ${violation.message}`,
      );
    }
  } else {
    console.log(
      `send-origin: ${String(dtoFiles.length)} files scanned for exempt-origin clause, 0 violations`,
    );
  }

  if (dtoViolations.length > 0) {
    for (const violation of dtoViolations) {
      console.error(
        `send-origin: ${violation.file}:${String(violation.line)} - ${violation.message}`,
      );
    }
  } else {
    console.log(
      `send-origin: ${String(dtoFiles.length)} files scanned for dto-origin clause, 0 violations`,
    );
  }

  // Clause (c) (P14 Unit U7): runs over the SAME broad-tree file set as
  // clause (a) - the exempt-set-shape half only ever looks at one file
  // (send-origin.ts), and the construction-site half needs the same
  // modules/pacing/internal/ files clause (a) already reads.
  const exemptShapeViolations = scanExemptOriginsLiteral(dtoFiles);
  const constructionSiteViolations = scanExemptOriginsHaveConstructionSite(dtoFiles);
  const clauseCViolations = [...exemptShapeViolations, ...constructionSiteViolations];

  if (clauseCViolations.length > 0) {
    for (const violation of clauseCViolations) {
      console.error(`send-origin: ${violation.file} - ${violation.message}`);
    }
  } else {
    console.log(
      `send-origin: ${String(dtoFiles.length)} files scanned for exempt-set-shape clause, 0 violations`,
    );
  }

  if (exemptViolations.length > 0 || dtoViolations.length > 0 || clauseCViolations.length > 0) {
    process.exit(1);
  }
}

const isMain =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
  main();
}

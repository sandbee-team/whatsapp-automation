import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { scanSendOrigin, scanExemptOriginsLiteral } from '../check-send-origin.js';
import { REPO_ROOT } from './registry.js';

/**
 * Fixture proof for check-send-origin.ts (P00 step 7, core invariant 6: no
 * pacing-bypass surface). `scanSendOrigin` is a pure function over
 * already-read source text, so every case feeds it fixture content under a
 * synthetic path chosen to mirror the real shape the clause cares about -
 * never touching the real filesystem scan.
 */

const FIXTURES_DIR = 'scripts/guards/__fixtures__/send-origin';

function readFixture(name: string): string {
  return readFileSync(path.join(REPO_ROOT, FIXTURES_DIR, name), 'utf8');
}

describe('check-send-origin (P00 step 7)', () => {
  it('system_reply_origin_outside_pacing_internal_is_rejected', () => {
    const leakedPath = 'app/backend/src/modules/queue/worker.service.ts';
    const okPath = 'app/backend/src/modules/pacing/internal/exemptions.ts';

    const violations = scanSendOrigin([
      { path: leakedPath, content: readFixture('leaked-origin.ts') },
      { path: okPath, content: readFixture('pacing-internal-ok.ts') },
    ]);

    // Bad: SYSTEM_REPLY referenced outside modules/pacing/internal/ - flagged.
    const leakedViolations = violations.filter((violation) => violation.file === leakedPath);
    expect(leakedViolations).toHaveLength(1);
    expect(leakedViolations[0]?.message).toContain('SYSTEM_REPLY');
    expect(leakedViolations[0]?.message).toContain('modules/pacing/internal/');

    // Good: the same identifiers referenced inside modules/pacing/internal/ -
    // never flagged, no exemption needed because the path itself is exempt.
    expect(violations.some((violation) => violation.file === okPath)).toBe(false);
  });

  it('a_dto_accepting_origin_from_input_is_rejected', () => {
    const dtoPath = 'app/backend/src/modules/messages/dto.ts';

    const violations = scanSendOrigin([
      { path: dtoPath, content: readFixture('dto-with-origin.ts') },
    ]);

    // Bad: `sendMessageInputSchema` has an `origin: z.string()` key - flagged
    // exactly once, at the `origin` line.
    expect(violations).toHaveLength(1);
    expect(violations[0]?.file).toBe(dtoPath);
    expect(violations[0]?.line).toBe(9);
    expect(violations[0]?.message).toContain('origin');

    // Good: `sendMessageCleanSchema` has no `origin` field - contributes no
    // second violation (the total count above is exactly 1, not 2).
  });

  // --- Edge-case / adversarial pass (session C2) --------------------------

  it('an_empty_file_list_flags_nothing', () => {
    expect(scanSendOrigin([])).toEqual([]);
  });

  it('a_system_reply_origin_referenced_as_a_computed_property_key_is_still_rejected', () => {
    const leakedPath = 'app/backend/src/modules/queue/worker.service.ts';

    const violations = scanSendOrigin([
      { path: leakedPath, content: readFixture('system-reply-computed-property.ts') },
    ]);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain('SYSTEM_REPLY');
  });

  it('a_dto_that_adds_origin_via_extend_is_still_rejected', () => {
    const dtoPath = 'app/backend/src/modules/messages/dto.ts';

    const violations = scanSendOrigin([
      { path: dtoPath, content: readFixture('dto-extend-origin.ts') },
    ]);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain('origin');
  });

  it('system_reply_referenced_anywhere_in_the_broad_tree_is_flagged_not_just_under_app_backend_modules', () => {
    // CRITICAL 2: the exempt-origin clause must run over the BROAD tree
    // (SEND_ORIGIN_DTO_GLOBS, the five source trees), not just
    // app/backend/src/modules/** - the path-based skip for
    // modules/pacing/internal/ inside scanExemptOriginReferences already
    // provides the exemption. Calls the pure core (scanSendOrigin) the same
    // way main() now does: over paths drawn from the broad tree, not the
    // narrow SEND_ORIGIN_EXEMPT_GLOBS tree.
    const sendWorkerPath = 'app/backend/src/roles/send-worker.ts';
    const serverKitPath = 'packages/server-kit/src/anything.ts';

    const violations = scanSendOrigin([
      { path: sendWorkerPath, content: readFixture('leaked-origin.ts') },
      { path: serverKitPath, content: readFixture('leaked-origin.ts') },
    ]);

    expect(
      violations.some(
        (violation) =>
          violation.file === sendWorkerPath && violation.message.includes('SYSTEM_REPLY'),
      ),
    ).toBe(true);
    expect(
      violations.some(
        (violation) =>
          violation.file === serverKitPath && violation.message.includes('SYSTEM_REPLY'),
      ),
    ).toBe(true);
  });

  it('a_thousand_repeated_leaked_origin_files_are_all_reported_and_stay_fast', () => {
    const content = readFixture('leaked-origin.ts');
    const files = Array.from({ length: 1000 }, (_, i) => ({
      path: `app/backend/src/modules/queue/worker-${String(i)}.service.ts`,
      content,
    }));

    const start = performance.now();
    const violations = scanSendOrigin(files);
    const elapsedMs = performance.now() - start;

    expect(violations).toHaveLength(1000);
    expect(elapsedMs).toBeLessThan(3000);
  });

  // --- Clause 3: EXEMPT_ORIGINS literal + real construction site (P14 U7) --

  it('exempt_send_origin_outside_pacing_internal_turns_the_guard_red', () => {
    // Case A: a synthetic file OUTSIDE modules/pacing/internal/ that
    // references the exempt uppercase identifier - built by concatenation so
    // this test's own source text never trips the real scanner over itself.
    const leakedIdentifier = ['SYSTEM', 'REPLY'].join('_');
    const leakedPath = 'app/backend/src/modules/messages/foo.ts';
    const leakedContent = `export const x = '${leakedIdentifier}';\n`;
    const caseAViolations = scanSendOrigin([{ path: leakedPath, content: leakedContent }]);
    expect(caseAViolations.some((v) => v.file === leakedPath)).toBe(true);

    // Case B: an EXEMPT_ORIGINS literal with a third member - clause 3
    // violation, regardless of where it lives.
    const sendOriginPath = 'packages/domain/src/pacing/send-origin.ts';
    const threeMemberContent = readFixture('exempt-origins-three-members.ts');
    const caseBViolations = scanExemptOriginsLiteral([
      { path: sendOriginPath, content: threeMemberContent },
    ]);
    expect(caseBViolations.length).toBeGreaterThan(0);

    // Case C: the real repo tree (send-origin.ts's real literal + the real
    // modules/pacing/internal/system-send.ts construction site) - zero
    // violations.
    const realSendOrigin = readFileSync(
      path.join(REPO_ROOT, 'packages/domain/src/pacing/send-origin.ts'),
      'utf8',
    );
    const realSystemSend = readFileSync(
      path.join(REPO_ROOT, 'app/backend/src/modules/pacing/internal/system-send.ts'),
      'utf8',
    );
    const realViolations = scanExemptOriginsLiteral([
      { path: sendOriginPath, content: realSendOrigin },
      {
        path: 'app/backend/src/modules/pacing/internal/system-send.ts',
        content: realSystemSend,
      },
    ]);
    expect(realViolations).toEqual([]);
  });
});

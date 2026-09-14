import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  scanForbiddenMechanisms,
  runCheckForbiddenMechanisms,
  PAUSED_EXIT_WRITER_PATH,
} from '../check-forbidden-mechanisms.js';
import type { SourceFile } from '../check-forbidden-mechanisms.js';
import { REPO_ROOT } from './registry.js';

/**
 * check-forbidden-mechanisms.test.ts (P16 Unit D, step 8; design test 30
 * `no_forbidden_mechanism_exists`) - fixture proof, following
 * `check-single-claim.test.ts`'s idiom: `scanForbiddenMechanisms` is a pure
 * function over already-read source text, every case feeds it one fixture
 * file from `__fixtures__/forbidden-mechanisms/` - never the real filesystem
 * scan (that is `runCheckForbiddenMechanisms`, exercised separately below
 * for the non-zero-scanned-count meta-assertion).
 */

const FIXTURES_DIR = 'scripts/guards/__fixtures__/forbidden-mechanisms';

function readFixture(name: string): SourceFile {
  const relativePath = `${FIXTURES_DIR}/${name}`;
  return { path: relativePath, content: readFileSync(path.join(REPO_ROOT, relativePath), 'utf8') };
}

function violates(name: string): boolean {
  return scanForbiddenMechanisms([readFixture(name)]).length > 0;
}

describe('check-forbidden-mechanisms (P16 Unit D, step 8)', () => {
  describe('no_code_path_leaves_paused_without_an_actor_user_id', () => {
    it('a_planted_system_actor_resume_outside_human_resume_ts_turns_red', () => {
      expect(violates('bad-system-actor-resume.ts')).toBe(true);
    });

    it('human_resume_ts_itself_without_a_UserActor_typed_parameter_turns_red', () => {
      // Simulates the real path so the "only human-resume.ts may leave
      // paused" branch is skipped and the "must type actor as UserActor"
      // branch is exercised instead.
      const fixture = readFixture('bad-human-resume-untyped-actor.ts');
      const asRealPath: SourceFile = { path: PAUSED_EXIT_WRITER_PATH, content: fixture.content };
      expect(scanForbiddenMechanisms([asRealPath]).length).toBeGreaterThan(0);
    });

    it('an_autoResume_identifier_anywhere_turns_red', () => {
      expect(violates('planted-auto-resume-identifier.ts')).toBe(true);
    });

    it('the_real_human_resume_ts_shape_at_its_real_path_stays_clean', () => {
      const fixture = readFixture('clean-human-resume.ts');
      const asRealPath: SourceFile = { path: PAUSED_EXIT_WRITER_PATH, content: fixture.content };
      expect(scanForbiddenMechanisms([asRealPath])).toHaveLength(0);
    });

    it('unrelated_clean_source_stays_clean', () => {
      expect(violates('clean-unrelated.ts')).toBe(false);
    });
  });

  it('the_real_repo_tree_today_has_zero_violations_and_a_non_zero_scanned_count', () => {
    const result = runCheckForbiddenMechanisms();
    expect(result.violations).toEqual([]);
    expect(result.filesScanned ?? 0).toBeGreaterThan(0);
  });

  // --- P24 groups-messaging Unit U2: banned group-management identifiers ---

  describe('no_group_management_call_exists_only_send_and_read_only_sync', () => {
    it('a_planted_add_participants_call_trips_the_guard', () => {
      // Built by concatenation so this test file's own source never
      // contains the banned identifier contiguously (same discipline as
      // `check-forbidden-mechanisms.ts`'s own product-name-token comment).
      const identifier = ['group', 'Participants', 'Update'].join('');
      const filePath = 'app/backend/src/provider/baileys/rogue-group-admin.ts';
      const content = `
        export async function addSomeone(sock: unknown, groupJid: string, jid: string) {
          // @ts-expect-error fixture-only shape
          await sock.${identifier}(groupJid, [jid], 'add');
        }
      `;
      const violations = scanForbiddenMechanisms([{ path: filePath, content }]);
      expect(violations.length).toBeGreaterThan(0);
    });

    it('a_file_containing_only_a_groupLeave_call_does_not_trip', () => {
      const identifier = ['group', 'Leave'].join('');
      const filePath = 'app/backend/src/provider/baileys/leave-group.ts';
      const content = `
        export async function leaveGroup(sock: unknown, groupJid: string) {
          // @ts-expect-error fixture-only shape
          await sock.${identifier}(groupJid);
        }
      `;
      expect(scanForbiddenMechanisms([{ path: filePath, content }])).toHaveLength(0);
    });
  });
});

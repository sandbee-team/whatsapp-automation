import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  API_KEY_ROUTES_ALLOWED_URLS,
  runCheckApiKeyRoutes,
  scanApiKeyRoutes,
} from '../check-api-key-routes.js';
import { REPO_ROOT } from '../guards/scan-config.js';

/**
 * check-api-key-routes.test.ts (go-live U3; widened P34 U-upload) - the
 * widening guard: fails if `policy: 'session_or_api_key'` appears on any
 * `registerRoute` call site other than the allow-listed URL(s) (`/v1/
 * messages`, joined by `/v1/media` in P34 U-upload) - a planted fixture at
 * another URL must fail naming that route; the real tree today must pass
 * with a non-zero scanned-file count (same idiom as
 * check-single-claim.test.ts's own real-tree assertion).
 */

const FIXTURES_DIR = 'scripts/guards/__fixtures__/api-key-routes';

function readFixture(name: string): string {
  return readFileSync(path.join(REPO_ROOT, FIXTURES_DIR, name), 'utf8');
}

describe('check-api-key-routes (go-live U3)', () => {
  it('a_session_or_api_key_policy_on_a_disallowed_url_fails_naming_the_route', () => {
    const filePath = `${FIXTURES_DIR}/bad-other-url.ts`;
    const files = [{ path: filePath, content: readFixture('bad-other-url.ts') }];

    const violations = scanApiKeyRoutes(files, API_KEY_ROUTES_ALLOWED_URLS);

    expect(violations.length).toBe(1);
    expect(violations[0]?.file).toBe(filePath);
    expect(violations[0]?.message).toMatch(/\/v1\/not-messages/);
  });

  it('a_session_or_api_key_policy_on_the_allowed_url_is_never_flagged', () => {
    const filePath = `${FIXTURES_DIR}/clean.ts`;
    const files = [{ path: filePath, content: readFixture('clean.ts') }];

    expect(scanApiKeyRoutes(files, API_KEY_ROUTES_ALLOWED_URLS)).toEqual([]);
  });

  it('an_empty_file_list_flags_nothing', () => {
    expect(scanApiKeyRoutes([], API_KEY_ROUTES_ALLOWED_URLS)).toEqual([]);
  });

  it('the_allow_list_is_exactly_v1_messages_and_v1_media_today', () => {
    expect(API_KEY_ROUTES_ALLOWED_URLS).toEqual(['/v1/messages', '/v1/media']);
  });

  it('the_real_repo_tree_today_has_zero_violations_and_a_non_zero_scanned_count', () => {
    const result = runCheckApiKeyRoutes();

    expect(result.violations).toEqual([]);
    expect(result.filesScanned).toBeGreaterThan(0);
  });
});

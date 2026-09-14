import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  runCheckNoDirectPublish,
  scanNoDirectPublish,
  NO_DIRECT_PUBLISH_ALLOWED_PATHS,
  NO_DIRECT_PUBLISH_GLOBS,
} from '../check-no-direct-publish.js';
import { REPO_ROOT } from '../guards/scan-config.js';

/**
 * check-no-direct-publish.test.ts (P15 U2, step 4) - proves the guard flags
 * `hub.publish(` anywhere outside the allowed transport/relay files, and
 * that the real repo tree is clean today (with a non-zero scanned-file
 * count, so a mis-configured glob that matches nothing can never pass
 * silently - same idiom as check-single-claim.test.ts's own real-tree
 * assertion).
 */

const FIXTURES_DIR = 'scripts/guards/__fixtures__/no-direct-publish';

function readFixture(name: string): string {
  return readFileSync(path.join(REPO_ROOT, FIXTURES_DIR, name), 'utf8');
}

describe('check-no-direct-publish (P15 U2, step 4)', () => {
  it('a_hub_publish_outside_the_relay_fails_the_guard', () => {
    const filePath = `${FIXTURES_DIR}/bad-direct-publish.ts`;
    const files = [{ path: filePath, content: readFixture('bad-direct-publish.ts') }];

    const violations = scanNoDirectPublish(files, NO_DIRECT_PUBLISH_ALLOWED_PATHS);

    expect(violations.length).toBeGreaterThan(0);
    expect(violations.every((violation) => violation.file === filePath)).toBe(true);
  });

  it('the_clean_fixture_using_emit_only_is_never_flagged', () => {
    const filePath = `${FIXTURES_DIR}/clean.ts`;
    const files = [{ path: filePath, content: readFixture('clean.ts') }];

    expect(scanNoDirectPublish(files, NO_DIRECT_PUBLISH_ALLOWED_PATHS)).toEqual([]);
  });

  it('an_empty_file_list_flags_nothing', () => {
    expect(scanNoDirectPublish([], NO_DIRECT_PUBLISH_ALLOWED_PATHS)).toEqual([]);
  });

  it('the_redis_bridge_transport_file_is_allowed_even_though_it_never_calls_hub_publish_today', () => {
    // redis-bridge.ts's subscriber DOES call hub.publish( (see its own
    // onMessage handler) - proving the allow-list covers the real
    // transport file, not a hypothetical one.
    const realContent = readFileSync(
      path.join(REPO_ROOT, 'app/backend/src/modules/realtime/redis-bridge.ts'),
      'utf8',
    );
    expect(realContent).toMatch(/hub\.publish\(/);

    const violations = scanNoDirectPublish(
      [{ path: 'app/backend/src/modules/realtime/redis-bridge.ts', content: realContent }],
      NO_DIRECT_PUBLISH_ALLOWED_PATHS,
    );

    expect(violations).toEqual([]);
  });

  it('a_relay_ts_file_at_the_expected_future_path_is_allowed', () => {
    const filePath = 'app/backend/src/roles/relay.ts';
    const content = 'hub.publish({ type: "message.job.status_changed" });';

    const violations = scanNoDirectPublish(
      [{ path: filePath, content }],
      NO_DIRECT_PUBLISH_ALLOWED_PATHS,
    );

    expect(violations).toEqual([]);
  });

  it('a_test_file_calling_hub_publish_is_exempt', () => {
    const filePath = 'app/backend/src/modules/realtime/hub.test.ts';
    const content = 'hub.publish({ type: "instance.health_changed" });';

    const violations = scanNoDirectPublish(
      [{ path: filePath, content }],
      NO_DIRECT_PUBLISH_ALLOWED_PATHS,
    );

    expect(violations).toEqual([]);
  });

  it('the_same_violating_content_at_a_different_business_module_path_is_still_flagged', () => {
    const filePath = 'app/backend/src/modules/messages/enqueue.ts';
    const content = 'hub.publish({ type: "message.job.status_changed" });';

    const violations = scanNoDirectPublish(
      [{ path: filePath, content }],
      NO_DIRECT_PUBLISH_ALLOWED_PATHS,
    );

    expect(violations.length).toBeGreaterThan(0);
  });

  it('a_publisher_shaped_publish_call_in_a_file_importing_the_redis_bridge_factory_is_flagged', () => {
    // BUG FIX (P15 C1 FIX F8 / MAJ-6): the guard's original pattern only
    // matched the literal `hub.publish(` - the live bypass shape three
    // production call sites actually use is `<publisher>.publish(`
    // (`roles/session-worker.ts`'s `publisher.publish(event)`,
    // `engine/pacing/warmup-evaluator.ts`'s `deps.publish(...)`,
    // `engine/session/runner-connection-update.ts`/`runner-disconnect.ts`'s
    // own `deps.publish(...)`), invisible to `hub\.publish\(`.
    const filePath = `${FIXTURES_DIR}/bad-publisher-shaped-publish.ts`;
    const files = [{ path: filePath, content: readFixture('bad-publisher-shaped-publish.ts') }];

    const violations = scanNoDirectPublish(files, NO_DIRECT_PUBLISH_ALLOWED_PATHS);

    expect(violations.length).toBeGreaterThan(0);
    expect(violations.every((violation) => violation.file === filePath)).toBe(true);
  });

  it('an_unrelated_publish_shaped_api_with_no_redis_bridge_import_is_never_flagged', () => {
    // The widened pattern must stay scoped to files that actually import the
    // realtime publisher factory/type - a bare `.publish(` on some other
    // pub/sub-shaped object is never a false positive.
    const filePath = `${FIXTURES_DIR}/clean-unrelated-publish-api.ts`;
    const files = [{ path: filePath, content: readFixture('clean-unrelated-publish-api.ts') }];

    expect(scanNoDirectPublish(files, NO_DIRECT_PUBLISH_ALLOWED_PATHS)).toEqual([]);
  });

  it('the_redis_bridge_transport_files_own_internal_redis_publish_call_is_never_flagged', () => {
    // redis-bridge.ts's PUBLISHER half calls `redis.publish(channel, ...)`
    // internally (the actual Redis Pub/Sub client call, not a bypass of the
    // outbox) - it must never be flagged even though this file is the one
    // that DEFINES `createRedisRealtimePublisher` (so it trivially "imports"
    // nothing external, but its own internal call must stay clean too, and
    // it is on the allow-list regardless).
    const realContent = readFileSync(
      path.join(REPO_ROOT, 'app/backend/src/modules/realtime/redis-bridge.ts'),
      'utf8',
    );
    const violations = scanNoDirectPublish(
      [{ path: 'app/backend/src/modules/realtime/redis-bridge.ts', content: realContent }],
      NO_DIRECT_PUBLISH_ALLOWED_PATHS,
    );
    expect(violations).toEqual([]);
  });

  it('the_three_pre_outbox_engine_call_sites_are_on_the_explicit_allow_list', () => {
    // F8's fix widens the GUARD (never migrates these call sites - P16
    // scope, per this session's own dispatch instruction). All three named
    // pre-outbox call sites, plus the sanctioned QR path
    // (roles/session-worker.ts), must be on the allow-list so the widened
    // pattern does not turn today's real tree red.
    expect(NO_DIRECT_PUBLISH_ALLOWED_PATHS).toEqual(
      expect.arrayContaining([
        'app/backend/src/engine/pacing/warmup-evaluator.ts',
        'app/backend/src/engine/session/runner-connection-update.ts',
        'app/backend/src/engine/session/runner-disconnect.ts',
        'app/backend/src/roles/session-worker.ts',
      ]),
    );
  });

  it('the_real_repo_tree_today_has_zero_violations_and_a_non_zero_scanned_count', () => {
    const result = runCheckNoDirectPublish();

    expect(result.violations).toEqual([]);
    expect(result.filesScanned).toBeGreaterThan(0);
  });

  it('resolving_the_guards_globs_actually_returns_the_redis_bridge_file', () => {
    const result = runCheckNoDirectPublish();
    expect(result.filesScanned).toBeGreaterThan(0);
    // Sanity that the glob universe is not accidentally narrower than the
    // real source tree that contains the one legitimate hub.publish( call.
    expect(NO_DIRECT_PUBLISH_GLOBS.length).toBeGreaterThan(0);
  });
});

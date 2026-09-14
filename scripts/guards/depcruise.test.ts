import { createRequire } from 'node:module';
import path from 'node:path';
import { cruise } from 'dependency-cruiser';
import type { IFlattenedRuleSet, IViolation } from 'dependency-cruiser';
import { describe, expect, it, beforeAll } from 'vitest';
import { REPO_ROOT } from './registry.js';

/**
 * Proves the repo's boundary rules (`.dependency-cruiser.cjs`, P00 step 4)
 * actually fire, by running dependency-cruiser's API against a known-bad
 * fixture tree whose folder names mirror the real tree
 * (`scripts/guards/__fixtures__/depcruise/`). The rules themselves are
 * `require()`d from the real config file - never hand-copied - so this test
 * fails if the real config regresses.
 */

const require = createRequire(import.meta.url);

const CONFIG_PATH = path.join(REPO_ROOT, '.dependency-cruiser.cjs');
const FIXTURE_DIR = path.join(REPO_ROOT, 'scripts', 'guards', '__fixtures__', 'depcruise');

let violations: IViolation[];

beforeAll(async () => {
  const config = require(CONFIG_PATH) as { forbidden: unknown };
  const ruleSet: IFlattenedRuleSet = {
    forbidden: config.forbidden as IFlattenedRuleSet['forbidden'],
  };

  const result = await cruise(
    ['.'],
    {
      validate: true,
      ruleSet,
      outputType: 'json',
      baseDir: FIXTURE_DIR,
    },
    {},
    {},
  );

  const parsed =
    typeof result.output === 'string'
      ? (JSON.parse(result.output) as { summary: { violations: IViolation[] } })
      : result.output;

  violations = (parsed as { summary: { violations: IViolation[] } }).summary.violations;
}, 30_000);

function violationsFor(ruleName: string): IViolation[] {
  return violations.filter((violation) => violation.rule.name === ruleName);
}

describe('scripts/** has no circular imports (real tree, not fixture)', () => {
  it('no_circular_scripts_rule_finds_zero_violations_in_the_real_scripts_tree', async () => {
    // Unlike the suite above, this cruises the REAL `scripts/` directory
    // (not the fixture tree) - it is the regression proof for the
    // registry.ts <-> check-tree.ts <-> check-tenant-scope.ts circular
    // import that crashed `tsx scripts/check-tenant-scope.ts` with a TDZ
    // ReferenceError (entry-point-dependent, so the pure-function-only unit
    // tests never caught it - see `cli-smoke.test.ts`).
    const config = require(CONFIG_PATH) as { forbidden: unknown };
    const forbidden = (config.forbidden as IFlattenedRuleSet['forbidden']) ?? [];
    const ruleSet: IFlattenedRuleSet = {
      forbidden: forbidden.filter((rule) => rule.name === 'no-circular-scripts'),
    };

    const result = await cruise(
      ['scripts'],
      { validate: true, ruleSet, outputType: 'json', baseDir: REPO_ROOT },
      {},
      {},
    );

    const parsed =
      typeof result.output === 'string'
        ? (JSON.parse(result.output) as {
            summary: { violations: IViolation[] };
          })
        : result.output;

    const realTreeViolations = (parsed as { summary: { violations: IViolation[] } }).summary
      .violations;

    expect(realTreeViolations).toEqual([]);
  }, 30_000);
});

describe('.dependency-cruiser.cjs boundary rules (fixture proof)', () => {
  it('domain_importing_pg_or_ioredis_is_rejected', () => {
    // Proves the *npm* rule fires - a `dependencyTypes:['core']` rule alone
    // never matches an npm package (blueprint [R-43]), because an
    // unresolved npm import like `pg` records dependencyTypes `['unknown']`,
    // not `['core']` or `['npm']`. domain-must-be-pure-npm matches on the
    // module path instead, so it must catch both `pg` and `ioredis`.
    const npmViolations = violationsFor('domain-must-be-pure-npm');
    const coreViolations = violationsFor('domain-must-be-pure-core');

    const targets = npmViolations
      .filter((violation) => violation.from === 'packages/domain/src/uses-pg.ts')
      .map((violation) => violation.to);

    expect(targets).toContain('pg');
    expect(targets).toContain('ioredis');

    // The core-only rule must NOT be what caught these - proving the point
    // of having a separate npm rule at all.
    expect(
      coreViolations.some((violation) => violation.from === 'packages/domain/src/uses-pg.ts'),
    ).toBe(false);
  });

  it('api_role_importing_provider_is_rejected', () => {
    // Fixture form of "the API never sends directly" (core invariant 1).
    const apiViolations = violationsFor('api-never-imports-provider');

    expect(
      apiViolations.some(
        (violation) =>
          violation.from === 'app/backend/src/roles/api.ts' &&
          violation.to === 'app/backend/src/provider/baileys/send.ts',
      ),
    ).toBe(true);
  });

  it('frontend_importing_server_kit_or_db_is_rejected', () => {
    const frontendViolations = violationsFor('frontend-never-server');

    expect(
      frontendViolations.some(
        (violation) =>
          violation.from === 'app/frontend/src/uses-server-kit.ts' &&
          violation.to === 'packages/server-kit/src/index.ts',
      ),
    ).toBe(true);
  });

  it('frontend_importing_server_kit_by_bare_specifier_is_rejected', () => {
    // The relative-path form above (`../../../packages/server-kit/src/index.js`)
    // resolves to a real file, so it matches the path-based half of
    // frontend-never-server's `to.path`. A bare `import '@wp/server-kit'` /
    // `import '@wp/db'` never resolves in this fixture tree (no node_modules) -
    // dependency-cruiser records the raw specifier as `to` in that case, which
    // only the bare-specifier regex alternative (CRITICAL 1a) can catch.
    //
    // P29a (2026-09-09): the root package.json now links `@wp/server-kit` as
    // a devDependency (the key-ring restore drill under infra/backup needs
    // the crypto API), so from this fixture tree the bare `@wp/server-kit`
    // specifier RESOLVES through the root node_modules symlink and depcruise
    // records the resolved file as `to`. The rule still fires (its path
    // alternative `^(packages/server-kit|db)/` matches the resolved file);
    // the bare-specifier alternative is still proven by the `@wp/db` case
    // below, which nothing at the root links.
    const frontendViolations = violationsFor('frontend-never-server');

    expect(
      frontendViolations.some(
        (violation) =>
          violation.from === 'app/frontend/src/uses-server-kit-bare.ts' &&
          (violation.to === '@wp/server-kit' || /(^|\/)packages\/server-kit\//.test(violation.to)),
      ),
    ).toBe(true);

    expect(
      frontendViolations.some(
        (violation) =>
          violation.from === 'app/frontend/src/uses-db-bare.ts' && violation.to === '@wp/db',
      ),
    ).toBe(true);
  });

  it('server_kit_src_importing_baileys_is_rejected', () => {
    // Core invariant: the WhatsApp engine is injected behind a codec/port
    // (P01 step 9), never imported directly from packages/server-kit/src.
    const serverKitViolations = violationsFor('server-kit-src-never-imports-baileys');

    expect(
      serverKitViolations.some(
        (violation) =>
          violation.from === 'packages/server-kit/src/uses-baileys.ts' &&
          violation.to === 'baileys',
      ),
    ).toBe(true);
  });

  it('server_kit_src_importing_the_scoped_whiskeysockets_baileys_fork_is_also_rejected', () => {
    // The rule's `to.path` alternates `(@whiskeysockets/)?baileys` - proves it
    // catches the scoped-package fork name form too, not just the bare
    // `baileys` specifier.
    const serverKitViolations = violationsFor('server-kit-src-never-imports-baileys');

    expect(
      serverKitViolations.some(
        (violation) =>
          violation.from === 'packages/server-kit/src/uses-whiskeysockets-baileys.ts' &&
          violation.to === '@whiskeysockets/baileys',
      ),
    ).toBe(true);
  });

  it('production_src_outside_measure_importing_engine_measure_is_rejected', () => {
    // The benchmark harness must be unreachable from production code - "a
    // benchmark double reachable from production code is a real outage
    // waiting to happen" (P10 U3 task spec).
    const violations = violationsFor('src-never-imports-engine-measure');

    expect(
      violations.some(
        (violation) =>
          violation.from === 'app/backend/src/roles/session-worker.ts' &&
          violation.to === 'app/backend/src/engine/measure/ramp-runner.ts',
      ),
    ).toBe(true);
  });

  it('production_src_outside_measure_importing_scripts_measure_is_rejected', () => {
    // Same boundary, the other benchmark-code location: scripts/measure/**
    // must also be unreachable from production `src`.
    const violations = violationsFor('src-never-imports-scripts-measure');

    expect(
      violations.some(
        (violation) =>
          violation.from === 'app/backend/src/roles/api-worker.ts' &&
          violation.to === 'scripts/measure/fake-ramp-sessions.ts',
      ),
    ).toBe(true);
  });

  it('app_importing_admin_is_rejected', () => {
    const crossProjectViolations = violationsFor('no-cross-project-app-to-admin');

    expect(
      crossProjectViolations.some(
        (violation) =>
          violation.from === 'app/frontend/src/uses-admin.ts' &&
          violation.to === 'admin/frontend/src/index.ts',
      ),
    ).toBe(true);
  });

  it('opt_out_mirror_is_never_read_by_the_pacing_gate', () => {
    // Design §2.5: contacts.opt_out_state is a MIRROR of opt_outs, never the
    // gate - modules/pacing/** (the gate) must never import
    // modules/contacts/** so the pacing path can never read the mirror.
    const pacingContactsViolations = violationsFor('pacing-never-imports-contacts');

    expect(
      pacingContactsViolations.some(
        (violation) =>
          violation.from === 'app/backend/src/modules/pacing/guards/reads-mirror.ts' &&
          violation.to === 'app/backend/src/modules/contacts/index.ts',
      ),
    ).toBe(true);
  });
});

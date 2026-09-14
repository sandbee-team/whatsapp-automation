/**
 * Repo-wide dependency-cruiser rules (P00 step 4).
 *
 * This file is the single source of truth for the boundary rules described
 * in `.memory/research/2026-08-25-v1-design-repo-structure.md` §2.3. It is
 * consumed two ways:
 *
 *   1. The CLI, via `pnpm run guards:depcruise` (see root package.json),
 *      which passes `--config .dependency-cruiser.cjs` and scans the five
 *      real source trees (`app`, `admin`, `website`, `packages`, `db`) -
 *      never `scripts/guards/__fixtures__/**`.
 *   2. `scripts/guards/depcruise.test.ts`, which `require()`s this file and
 *      runs the dependency-cruiser API (`cruise()`) directly against the
 *      known-bad fixture tree in `scripts/guards/__fixtures__/depcruise/`
 *      with `baseDir` set to that fixture directory. Because the fixture
 *      tree's folder names mirror the real tree (`packages/domain/src/...`,
 *      `app/backend/src/roles/api.ts`, ...), the exact same regexes defined
 *      here apply verbatim - the test fails if these rules ever change in a
 *      way that stops catching the violation they exist to catch.
 *
 * Note on `no-deep-module-import`'s `to.path`: dependency-cruiser supports
 * substituting a `from.path` capturing group into `to.path` with `$<n>`
 * placeholders (see `replaceGroupPlaceholders` in
 * `node_modules/dependency-cruiser/src/utl/regex-util.mjs`) - NOT a regex
 * backreference (`\1`). The design doc's original sketch used `$1`; that is
 * the syntax actually implemented, so this file uses it.
 */

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'domain-must-be-pure-core',
      severity: 'error',
      comment:
        '@wp/domain must run unchanged in a browser: no Node core builtins ' +
        '(fs, path, crypto, net, http, ...). Blueprint [R-43]: a ' +
        "dependencyTypes:['core'] rule alone never matches an npm package - " +
        'that is what domain-must-be-pure-npm is for. Scoped to src/ only ' +
        '(not tests/): the purity proof itself (P00 step 8, ' +
        'packages/domain/tests/purity.test.ts) has to spawn the real build ' +
        'and read its output file, which is test tooling, not shipped code.',
      from: { path: '^packages/domain/src/' },
      to: {
        dependencyTypes: ['core'],
        path: '^(node:)?(fs|path|crypto|pg|net|http|https|os|child_process|worker_threads|cluster|dns|tls|stream|buffer|process|util|url|zlib|events)$',
      },
    },
    {
      name: 'domain-must-be-pure-npm',
      severity: 'error',
      comment:
        '@wp/domain must never depend on server-only npm packages (pg, ' +
        'ioredis, redis, drizzle-orm, pino, fastify) or the server-only ' +
        'workspace packages @wp/db / @wp/server-kit, resolved or not - an ' +
        'unresolved import still records its module specifier as `resolved`. ' +
        'Scoped to src/ only - see domain-must-be-pure-core comment above.',
      from: { path: '^packages/domain/src/' },
      to: {
        path: '(^|/)(pg|ioredis|redis|drizzle-orm|pino|fastify)($|/)|^@wp/(db|server-kit)$|^(packages/server-kit|db)/',
      },
    },
    {
      name: 'no-cross-project-app-to-admin',
      severity: 'error',
      comment:
        'app/* and admin/* are separate deployables - no cross-project import, ever. ' +
        'to.path also matches the bare workspace project specifier form (e.g. `import' +
        " 'admin-frontend'`, package.json name, not a relative/path import) so this " +
        'rule fires whether or not the import happens to resolve to a real file.',
      from: { path: '^app/' },
      to: { path: '^admin/|^(app|admin)-(backend|frontend)$' },
    },
    {
      name: 'no-cross-project-admin-to-app',
      severity: 'error',
      comment:
        'app/* and admin/* are separate deployables - no cross-project import, ever. ' +
        'See no-cross-project-app-to-admin for the bare-specifier note.',
      from: { path: '^admin/' },
      to: { path: '^app/|^(app|admin)-(backend|frontend)$' },
    },
    {
      name: 'frontend-never-server',
      severity: 'error',
      comment:
        'No frontend may import server-only code (@wp/server-kit) or the DB layer. ' +
        'to.path also matches the bare `@wp/server-kit` / `@wp/db` package specifier ' +
        "form - an import like `import '@wp/server-kit'` from frontend code has no " +
        'relative/workspace-resolvable file path to match against (it only resolves ' +
        'through node_modules or, in an unresolvable fixture tree, not at all), so the ' +
        'path-only pattern alone never fires on that real-world import shape. ' +
        'P29a (2026-09-09): the root package.json links @wp/server-kit as a devDependency ' +
        '(infra/backup key-ring drill), so the bare specifier now RESOLVES through the ' +
        'root node_modules symlink to the real packages/server-kit file - from a baseDir ' +
        'other than the repo root (the fixture tree) that resolved path is prefixed with ' +
        '`../`, hence the `(^|/)packages/server-kit/` alternative.',
      from: { path: '^(app|admin)/frontend/|^website/' },
      to: { path: '^(packages/server-kit|db)/|(^|/)packages/server-kit/|^@wp/(server-kit|db)$' },
    },
    {
      name: 'packages-never-apps',
      severity: 'error',
      comment:
        'Shared packages are consumed by the four projects; they never depend on one. ' +
        'to.path also matches the bare workspace project specifier form (package.json ' +
        'name: app-backend, app-frontend, admin-backend, admin-frontend, website).',
      from: { path: '^packages/' },
      to: { path: '^(app|admin|website)/|^(app|admin)-(backend|frontend)$|^website$' },
    },
    {
      name: 'no-deep-module-import',
      severity: 'error',
      comment:
        'A backend module may only be reached through its public surface ' +
        '(index.ts); no reaching into another module of the same backend. ' +
        'activatesIn P11 - no app/backend/src/modules/** files exist yet. ' +
        'from.pathNot exempts test files (same TEST_FILE_PATTERN shape as ' +
        'check-tenant-scope.ts) - not production laxity: shared test ' +
        'infrastructure legitimately crosses module boundaries. Concretely, ' +
        'modules/realtime/__test-support__/stub-wp-server-kit-env.ts is a ' +
        "process-env-singleton workaround (packages/server-kit's `config` " +
        'parses process.env once at first import anywhere in the process) ' +
        'that MUST be the first import of any app/backend unit test whose ' +
        'import chain reaches @wp/server-kit, regardless of which module the ' +
        'test lives under; it only sits under modules/realtime/ for ' +
        'historical (P05) reasons. Only from is exempted - production code ' +
        "(to.path, unchanged) still cannot reach into another module's " +
        'internals from a test OR from shipped src.',
      from: {
        path: '^app/backend/src/modules/([^/]+)/',
        pathNot: '(^|/)(__tests__|tests?)/|\\.(test|spec)\\.tsx?$',
      },
      to: { path: '^app/backend/src/modules/(?!$1/)[^/]+/(?!index\\.ts$)' },
    },
    {
      name: 'pacing-never-imports-contacts',
      severity: 'error',
      comment:
        'Design §2.5: contacts.opt_out_state is a MIRROR of opt_outs, never ' +
        'the gate. modules/pacing/** (the gate) may not import ' +
        'modules/contacts/** so the pacing path can never read the mirror; ' +
        'the mirror writer is INJECTED into recordOptOut/restoreOptOut as a ' +
        'port instead (P20 U8). Test: ' +
        'opt_out_mirror_is_never_read_by_the_pacing_gate.',
      from: { path: '^app/backend/src/modules/pacing/' },
      to: { path: '^app/backend/src/modules/contacts/' },
    },
    {
      name: 'api-never-imports-provider',
      severity: 'error',
      comment:
        'Core invariant 1: the API never sends directly - it creates durable ' +
        'jobs only. activatesIn P08 - roles/api.ts and provider/** do not exist yet.',
      from: { path: '^app/backend/src/roles/api\\.ts$' },
      to: { path: '^app/backend/src/provider/' },
    },
    {
      name: 'server-kit-src-never-imports-baileys',
      severity: 'error',
      comment:
        '@wp/server-kit/src is transport-agnostic: the WhatsApp engine ' +
        '(Baileys) is injected behind a codec/port, not imported directly ' +
        '(P01 step 9). The ONLY allowed Baileys reference anywhere in this ' +
        'package is the test-only devDependency used by ' +
        'packages/server-kit/test/** (test/ sits outside src/, so this rule ' +
        "scope keeps that usage legal). Matches both the bare 'baileys' " +
        "specifier and the '@whiskeysockets/baileys' fork name, resolved or " +
        'not.',
      from: { path: '^packages/server-kit/src/' },
      to: { path: '(^|/)(@whiskeysockets/)?baileys($|/)' },
    },
    {
      name: 'src-never-imports-engine-measure',
      severity: 'error',
      comment:
        'The benchmark harness must be unreachable from production code - ' +
        '"a benchmark double reachable from production code is a real ' +
        'outage waiting to happen" (P10 U3). app/backend/src/** that is NOT ' +
        'itself under engine/measure/** may not import engine/measure/** - ' +
        'the measurement harness (mock-wa-peer, measure-fleet, the ramp ' +
        'runner integration test) stays a leaf only measurement code reaches.',
      from: { path: '^app/backend/src/(?!engine/measure/)' },
      to: { path: '^app/backend/src/engine/measure/' },
    },
    {
      name: 'src-never-imports-scripts-measure',
      severity: 'error',
      comment:
        'Same boundary as src-never-imports-engine-measure, the other ' +
        'benchmark-code location: production app/backend/src/** (outside ' +
        'engine/measure/**, which legitimately imports the ramp runner from ' +
        'its own integration test) may never import scripts/measure/** - the ' +
        'ramp runner/sampler/artifact writer are measurement-only tooling.',
      from: { path: '^app/backend/src/(?!engine/measure/)' },
      to: { path: '^scripts/measure/' },
    },
    {
      name: 'no-circular-scripts',
      severity: 'error',
      comment:
        'scripts/** (the guard/CLI tooling) must never have a circular ' +
        'import - a cycle among these modules produces an entry-point-' +
        'dependent TDZ crash (a module accessed before its own top-level ' +
        'code finishes running), which the vitest suites can miss entirely ' +
        'because they only ever import pure functions, never spawn the CLI ' +
        'as its own entry module. Not wired into `guards:depcruise` (which ' +
        'only scans the five ADR 0014 source trees) - proved instead by ' +
        '`scripts/guards/depcruise.test.ts` cruising the real `scripts/` ' +
        'tree directly. Run manually with ' +
        '`pnpm exec depcruise scripts --config .dependency-cruiser.cjs`.',
      from: { path: '^scripts/' },
      to: { circular: true },
    },
  ],
  options: {
    // Record npm dependencies as leaf nodes (needed for domain-must-be-pure-npm
    // and frontend-never-server to see them) without recursively cruising into
    // their own node_modules trees - keeps the scan fast and focused on the
    // repo's own boundary rules.
    doNotFollow: {
      path: 'node_modules',
      dependencyTypes: ['npm', 'npm-dev', 'npm-optional', 'npm-peer', 'npm-bundled', 'npm-no-pkg'],
    },
    exclude: {
      path: '(^|/)(dist|coverage|\\.turbo|\\.next)/|^website/out/',
    },
  },
};

// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

/**
 * Shared ESLint 9+ flat config base for the WP workspace.
 * Consuming packages import this array and append their own overrides:
 *
 *   import base from '@wp/config/eslint.config.js';
 *   export default [...base, { ...myOverrides }];
 */
// ---------------------------------------------------------------------
// Guard rule messages (P00 step 5). Every guard message is prefixed with its
// `wp/<name>` tag so the registry + tests can filter no-restricted-syntax
// hits by guard without depending on ESLint reporting a distinct ruleId.
// ---------------------------------------------------------------------

const SET_MESSAGE =
  'wp/no-plain-set: plain SET is banned - transaction pooling makes a session-scoped SET a ' +
  'cross-tenant leak. Accepted forms only: "SET LOCAL ..." and set_config(key, value, true).';

const OFFSET_MESSAGE =
  'wp/no-offset-pagination: OFFSET pagination is banned - lists are keyset-paginated ' +
  '(cursor: WHERE id > $1 ORDER BY id LIMIT n), never counted by page offset.';

const KEY_MESSAGE =
  "wp/key-construction: a raw 'wp:' Redis key literal is only allowed inside platform/redis - " +
  'build keys with tenantKey()/sysKey() everywhere else.';

const WALLCLOCK_MESSAGE =
  'wp/domain-no-wallclock: packages/domain must stay pure and run unchanged in a browser - ' +
  'Date.now(), Math.random() and zero-arg new Date() are banned; the caller injects clock and RNG.';

// `no-restricted-syntax` is a single core rule - a flat-config object that
// re-declares `rules['no-restricted-syntax']` for a file REPLACES (does not
// merge with) whatever an earlier-matching config object set for that same
// file, so every selector a given file must be checked against has to be
// composed into ONE array per file-scope below (SET/OFFSET/KEY/WALLCLOCK
// entry lists are reused, never re-declared, to keep that composition exact).

// Exported (not just module-local) so the fixture-proof test
// (`scripts/guards/eslint-guards.test.ts`) and the guard registry
// (`scripts/guards/registry.ts`) never hand-copy a selector - there is
// exactly one source of truth for each rule's selector set.
export const SET_ENTRIES = [
  {
    // Statement-position "SET " not followed by "LOCAL" - anchored to
    // start-of-string or after `;`/newline so ordinary English text
    // ("data SET loaded") never false-positives.
    selector: 'Literal[value=/(^|;|\\n)\\s*SET\\s+(?!LOCAL\\b)/i]',
    message: SET_MESSAGE,
  },
  {
    selector: 'TemplateElement[value.raw=/(^|;|\\n)\\s*SET\\s+(?!LOCAL\\b)/i]',
    message: SET_MESSAGE,
  },
];

export const OFFSET_ENTRIES = [
  {
    selector: 'Literal[value=/\\bOFFSET\\s+/i]',
    message: OFFSET_MESSAGE,
  },
  {
    selector: 'TemplateElement[value.raw=/\\bOFFSET\\s+/i]',
    message: OFFSET_MESSAGE,
  },
  {
    // The Drizzle `.offset()` query-builder call.
    selector: "CallExpression[callee.property.name='offset']",
    message: OFFSET_MESSAGE,
  },
];

export const KEY_ENTRIES = [
  {
    selector: 'Literal[value=/^wp:/]',
    message: KEY_MESSAGE,
  },
  {
    // Only the first quasi (the literal text before the first `${}`) - a
    // `wp:` prefix must start the key, not appear mid-template.
    selector: 'TemplateLiteral > TemplateElement:first-child[value.raw=/^wp:/]',
    message: KEY_MESSAGE,
  },
];

export const WALLCLOCK_ENTRIES = [
  {
    selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
    message: WALLCLOCK_MESSAGE,
  },
  {
    selector: "CallExpression[callee.object.name='Math'][callee.property.name='random']",
    message: WALLCLOCK_MESSAGE,
  },
  {
    selector: "NewExpression[callee.name='Date'][arguments.length=0]",
    message: WALLCLOCK_MESSAGE,
  },
];

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      // Non-workspace / off-limits directories (see CLAUDE.md).
      'demo/**',
      '.memory/**',
      '.claude/**',
      'plan/**',
      // Known-bad guard self-test fixtures - never scanned by the real lint
      // run (see scripts/guards/eslint-guards.test.ts, which lints their
      // text directly via ESLint#lintText with a non-fixture filePath).
      'scripts/guards/__fixtures__/**',
      // TanStack Router codegen (P04b UB2) - regenerated on every dev/build,
      // never hand-edited; already self-disables via its own
      // `/* eslint-disable */` header, excluded here too so it never counts
      // toward max-lines or shows up in lint output.
      'app/frontend/src/routeTree.gen.ts',
      // P29: Next.js build output + generated env, never hand-edited.
      'website/.next/**',
      'website/out/**',
      'website/next-env.d.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },

  // ---------------------------------------------------------------------
  // Guard-specific rules (P00 step 5): plain SET, OFFSET pagination, raw
  // `wp:` Redis key literals, and packages/domain wall-clock/RNG purity.
  // See plan/v1/P00-workspace-guards-and-domain.md.
  //
  // IMPORTANT: `no-restricted-syntax` is a single core rule. A later flat
  // -config object that matches the same file and re-declares
  // `rules['no-restricted-syntax']` REPLACES (does not merge with) an
  // earlier object's value for that file. Every block below that can match
  // the same file must therefore carry the FULL selector set that file
  // needs - never assume an earlier block's entries still apply.
  // ---------------------------------------------------------------------
  {
    // Plain SET / OFFSET pagination / raw `wp:` key literals: banned in
    // workspace TS EXCEPT platform/redis (see next block).
    files: ['**/*.ts', '**/*.tsx'],
    ignores: ['**/platform/redis/**'],
    rules: {
      'no-restricted-syntax': ['error', ...SET_ENTRIES, ...OFFSET_ENTRIES, ...KEY_ENTRIES],
    },
  },
  {
    // platform/redis is the one place allowed to build raw `wp:` keys (P01
    // server-kit's tenantKey()/sysKey() helpers live there) - SET/OFFSET
    // are still banned there, so this block re-declares those two families
    // without KEY_ENTRIES.
    files: ['**/platform/redis/**/*.ts', '**/platform/redis/**/*.tsx'],
    rules: {
      'no-restricted-syntax': ['error', ...SET_ENTRIES, ...OFFSET_ENTRIES],
    },
  },
  {
    // @wp/domain must not read the wall clock or RNG directly - clock and
    // RNG are always injected by the caller (blueprint: browser-portable,
    // pure business logic). This block matches a subset of the first
    // block's files, so it must also carry SET/OFFSET/KEY to keep those
    // checks live inside packages/domain, plus WALLCLOCK_ENTRIES.
    files: ['packages/domain/src/**/*.ts', 'packages/domain/src/**/*.tsx'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...SET_ENTRIES,
        ...OFFSET_ENTRIES,
        ...KEY_ENTRIES,
        ...WALLCLOCK_ENTRIES,
      ],
    },
  },
  {
    // Superseded the earlier warn/200 baseline now that the guard rules
    // above are in place - counts every line (blank/comment included) so a
    // file can't dodge the limit by padding with comments.
    rules: {
      'max-lines': ['error', { max: 300, skipBlankLines: false, skipComments: false }],
    },
  },
);

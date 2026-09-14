import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Proves `@wp/domain` really is runtime-agnostic (blueprint: "must run
 * unchanged in a browser") by running the real production build - the same
 * command CI runs (`domain:browser-build` -> `pnpm -F @wp/domain run
 * build:browser`) - and grepping the emitted bundle for anything that only
 * exists in Node (a `require("node:...")`/`from "node:...")` or bare Node
 * builtin specifier). Lives in `tests/`, not `src/`, because it has to
 * spawn a process and read a file - see `.dependency-cruiser.cjs`'s
 * `domain-must-be-pure-*` rules, scoped to `src/` for exactly this reason.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = path.resolve(HERE, '..');
const BUNDLE_PATH = path.join(PACKAGE_DIR, 'dist', 'browser', 'index.js');

const NODE_BUILTINS = [
  'assert',
  'buffer',
  'child_process',
  'cluster',
  'crypto',
  'dns',
  'events',
  'fs',
  'http',
  'https',
  'net',
  'os',
  'path',
  'process',
  'stream',
  'tls',
  'url',
  'util',
  'worker_threads',
  'zlib',
];

describe('@wp/domain browser build', () => {
  it('domain_bundles_for_a_browser_target_with_no_node_builtins', () => {
    const result = spawnSync('pnpm -F @wp/domain run build:browser', {
      cwd: path.resolve(PACKAGE_DIR, '..', '..'),
      encoding: 'utf8',
      shell: true,
    });

    expect(result.status).toBe(0);

    const bundle = readFileSync(BUNDLE_PATH, 'utf8');

    expect(bundle).not.toMatch(/require\(\s*["']node:/);
    expect(bundle).not.toMatch(/from\s+["']node:/);

    for (const builtin of NODE_BUILTINS) {
      const barePattern = new RegExp(
        `(?:require\\(\\s*["']${builtin}["']\\s*\\)|from\\s+["']${builtin}["'])`,
      );
      expect(bundle).not.toMatch(barePattern);
    }
  }, 60_000);
});

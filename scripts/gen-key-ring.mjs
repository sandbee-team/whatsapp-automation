#!/usr/bin/env node
/**
 * Dev-only key-ring generator (P01 step 10).
 *
 * Writes a fresh key ring matching the schema in
 * `packages/server-kit/src/crypto/key-ring-schema.ts`: one ACTIVE key per
 * purpose (`session`, `tenant-secrets`, `user-secrets`), each with
 * `crypto.randomBytes(32)` material.
 *
 * This is strictly a developer/test convenience:
 *   - refuses to run when `WP_ENV=production` - production key-ring
 *     provisioning (the 3-copy rule, restore drill) is P29's job, not this
 *     script's.
 *   - refuses to overwrite an existing ring file - key loss means every
 *     tenant re-scans a QR code; never silently clobber a ring.
 *   - never prints key material, only the output path.
 *
 * Usage: `node scripts/gen-key-ring.mjs [--out <path>]`
 * Default output: `.secrets/key-ring.dev.json` (repo root).
 */

import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const KEK_PURPOSES = ['session', 'tenant-secrets', 'user-secrets'];

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..');
const DEFAULT_OUT = path.join(REPO_ROOT, '.secrets', 'key-ring.dev.json');

/** Parses `--out <path>` from argv; returns the default when absent. */
export function parseOutPath(argv, { defaultOut = DEFAULT_OUT, cwd = process.cwd() } = {}) {
  const flagIndex = argv.indexOf('--out');
  if (flagIndex === -1) {
    return defaultOut;
  }
  const value = argv[flagIndex + 1];
  if (value === undefined) {
    throw new Error('--out requires a path argument');
  }
  return path.isAbsolute(value) ? value : path.resolve(cwd, value);
}

/** Builds a fresh dev key ring: one active, non-retired key per purpose. */
export function buildDevKeyRing({ now = new Date() } = {}) {
  const createdAt = now.toISOString();
  const active = {};
  const keys = {};

  for (const purpose of KEK_PURPOSES) {
    const kekId = `dev-${purpose}-${randomBytes(4).toString('hex')}`;
    active[purpose] = kekId;
    keys[kekId] = {
      purpose,
      material: randomBytes(32).toString('base64'),
      created_at: createdAt,
    };
  }

  return { version: 1, active, keys };
}

function refuseIfProduction(env) {
  if (env.WP_ENV === 'production') {
    console.error(
      'gen-key-ring: refusing to run with WP_ENV=production - this generator is dev-only. ' +
        'Production key-ring provisioning is handled by the P29 procedure.',
    );
    process.exit(1);
  }
}

/**
 * Writes the ring atomically with `flag: 'wx'` (open for writing, fail if
 * the path already exists) rather than an `existsSync`-then-`writeFileSync`
 * check-then-act pair, which has a TOCTOU race: another process could create
 * the file between the check and the write, silently clobbering it. `mode`
 * is a no-op on Windows but correct (owner-only) on the Linux VPS.
 */
function writeRingAtomically(outPath, ring) {
  try {
    writeFileSync(outPath, `${JSON.stringify(ring, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
  } catch (err) {
    if (err.code === 'EEXIST') {
      console.error(
        `gen-key-ring: refusing to overwrite existing key ring at "${outPath}". ` +
          'Delete it yourself first if you really mean to replace it.',
      );
      process.exit(1);
    }
    throw err;
  }
}

function main() {
  refuseIfProduction(process.env);

  const outPath = parseOutPath(process.argv.slice(2));

  mkdirSync(path.dirname(outPath), { recursive: true, mode: 0o700 });

  const ring = buildDevKeyRing();
  writeRingAtomically(outPath, ring);

  console.log(`gen-key-ring: wrote a dev-only key ring to "${outPath}".`);
  console.log(
    'gen-key-ring: this ring is dev-only - never copy it out of this machine, ' +
      'never commit it, never use it in production.',
  );
}

const isMain =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
  main();
}

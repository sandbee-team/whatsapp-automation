#!/usr/bin/env node
/**
 * PRODUCTION key-ring generator (2026-09-14).
 *
 * `gen-key-ring.mjs` is deliberately dev-only: it refuses to run when
 * `WP_ENV=production`, and it seeds only three of the five purposes the code
 * now uses. That left a first deployment with no sanctioned way to produce a
 * real ring, so this script exists.
 *
 * WHAT A KEY RING IS, in one line: the file holding the master keys that
 * encrypt every WhatsApp session and tenant secret in the database.
 *
 * LOSING IT IS UNRECOVERABLE. Nothing in the database can be decrypted
 * without it: every linked WhatsApp number must be re-scanned by its owner,
 * and stored tenant secrets are gone. That is why the launch checklist (row
 * 23) requires it to exist in exactly THREE places before go-live:
 *   1. the production host, at /etc/wp/keyring/key-ring.json, chmod 600
 *   2. an encrypted offline copy the founder holds
 *   3. a second sealed offline copy stored separately
 *
 * It is NOT a password you can reset. Treat it like the only copy of a
 * private key, because that is what it is.
 *
 * Usage:
 *   node scripts/gen-production-key-ring.mjs --out ./key-ring.json
 *
 * The script refuses to overwrite an existing file, and never prints key
 * material - only the path it wrote and a SHA-256 checksum you can use to
 * verify the three copies are identical.
 */

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// Must match `KEK_PURPOSES` in packages/server-kit/src/config/schema.ts. The
// ring's schema validates `active` as an EXHAUSTIVE record over this enum, so
// a ring missing any one purpose fails at boot with CRYPTO_KEY_RING_INVALID.
const KEK_PURPOSES = [
  'session',
  'tenant-secrets',
  'user-secrets',
  'optout-pepper',
  'api-key-pepper',
];

function parseOut(argv) {
  const i = argv.indexOf('--out');
  if (i === -1 || !argv[i + 1]) {
    console.error('Usage: node scripts/gen-production-key-ring.mjs --out <path>');
    process.exit(1);
  }
  return path.resolve(argv[i + 1]);
}

function main() {
  const outPath = parseOut(process.argv.slice(2));

  // Never clobber a ring: an overwrite is equivalent to deleting every key.
  if (existsSync(outPath)) {
    console.error(`Refusing to overwrite an existing key ring at ${outPath}.`);
    console.error('If you truly want a new ring, move the old one aside FIRST and keep it.');
    process.exit(1);
  }

  const createdAt = new Date().toISOString();
  const active = {};
  const keys = {};

  KEK_PURPOSES.forEach((purpose, index) => {
    const kekId = `k${String(index + 1)}`;
    active[purpose] = kekId;
    keys[kekId] = {
      purpose,
      // 32 bytes = AES-256. base64 in the file, decoded at load.
      material: randomBytes(32).toString('base64'),
      created_at: createdAt,
      retired: false,
    };
  });

  const ring = { version: 1, active, keys };
  const json = `${JSON.stringify(ring, null, 2)}\n`;

  mkdirSync(path.dirname(outPath), { recursive: true });
  // 0o600: owner read/write only. On Windows this is advisory; the file is
  // still written, and the real permissions are set on the Linux host.
  writeFileSync(outPath, json, { mode: 0o600 });

  const checksum = createHash('sha256').update(json).digest('hex');

  console.log(`Key ring written: ${outPath}`);
  console.log(`Purposes: ${KEK_PURPOSES.join(', ')}`);
  console.log(`SHA-256:  ${checksum}`);
  console.log('');
  console.log('NEXT, and do not skip this:');
  console.log(
    '  1. Copy it to the server at /etc/wp/keyring/key-ring.json (chmod 600, root-owned).',
  );
  console.log('  2. Keep an encrypted offline copy.');
  console.log('  3. Keep a second sealed offline copy somewhere separate.');
  console.log('Verify each copy with: sha256sum key-ring.json  (it must match the SHA-256 above).');
  console.log('');
  console.log('If you lose this file, every linked WhatsApp number must be re-scanned.');
}

main();

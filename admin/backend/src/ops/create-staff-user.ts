import { randomUUID, randomInt } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { hash as argon2Hash, type Algorithm } from '@node-rs/argon2';
import { generateSecret, generateURI } from 'otplib';
import { createPool } from '@wp/db';
import { FileKeyProvider, seal } from '@wp/server-kit/crypto';

/**
 * ops/create-staff-user.ts (P28 Unit U4, step 5) - the ONLY way a
 * staff account comes into existence. There is deliberately no
 * self-service staff signup and no "create staff user" admin endpoint: a
 * staff account grants cross-tenant read access to every workspace on the
 * platform, so creating one requires database credentials, which means it
 * requires an operator with production access.
 *
 * What it produces, per run:
 *  - a 20-character random temporary password, printed EXACTLY ONCE (never
 *    stored, never logged elsewhere - only its argon2id hash reaches the
 *    database);
 *  - a fresh TOTP secret, SEALED with envelope crypto (purpose
 *    `user-secrets`) before it touches `staff_users.mfa_totp_secret_enc`,
 *    in the same `bytea` codec this package's `staff-auth/totp.ts`
 *    reads - that codec is a STORAGE CONTRACT shared between the two, and
 *    changing it on one side breaks logins on the other;
 *  - the `otpauth://` URL for the authenticator app.
 *
 * `mfa_enabled_at` is set to `now()` IMMEDIATELY, not left NULL for the
 * staff member to "enrol later". TOTP is mandatory for staff, and an
 * account with a NULL `mfa_enabled_at` cannot log in at all
 * (403 `MFA_ENROLL_REQUIRED`) - so the enrolment has to be complete before
 * the account is usable, and the operator hands over both factors together.
 *
 * Usage:
 *   DATABASE_URL=... WP_KEY_RING_PATH=... \
 *     pnpm -F admin-backend exec tsx src/ops/create-staff-user.ts \
 *     --email ops@example.com --name "Ops Person" --role ops
 *
 * WHY IT LIVES HERE, not under `scripts/ops/`: it needs `@wp/db` and
 * `@wp/server-kit/crypto`, and `scripts/**` is not a pnpm workspace member,
 * so those specifiers would only resolve from the repo ROOT
 * devDependencies - and adding them there makes a bare `@wp/server-kit`
 * import resolvable repo-wide, which breaks
 * `scripts/guards/depcruise.test.ts#frontend_importing_server_kit_by_bare_specifier_is_rejected`
 * (that guard relies on the specifier NOT resolving in its fixture tree).
 * `admin/backend` already declares both dependencies, and this is
 * admin-owned tooling, so it belongs to that package.
 *
 * See `docs/RUNBOOK.md` -> "staff-accounts" for the lockout-reset and
 * disable procedures, and for the honest note that direct `psql` access by
 * a staff member is NOT audited (there is no pgaudit in v1).
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..');
const DEV_ENV_PATH = path.join(REPO_ROOT, '.secrets', 'dev.env');
const ARGON2ID = 2 as Algorithm;
const STAFF_ROLES = ['support', 'ops', 'superadmin'] as const;
type StaffRoleArg = (typeof STAFF_ROLES)[number];

/** OWASP baseline - identical to the production login verifier's params. */
const ARGON2_PARAMS = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

// No ambiguous 0/O/1/l/I - the operator reads this aloud or pastes it once.
const PASSWORD_ALPHABET = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#%^&*';
const PASSWORD_LENGTH = 20;

function parseArgs(argv: string[]): { email: string; name: string; role: StaffRoleArg } {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag?.startsWith('--')) {
      args.set(flag.slice(2), argv[i + 1] ?? '');
      i += 1;
    }
  }
  const email = (args.get('email') ?? '').trim();
  const name = (args.get('name') ?? '').trim();
  const role = (args.get('role') ?? '').trim() as StaffRoleArg;

  if (!email || !email.includes('@')) {
    throw new Error('--email is required and must look like an address');
  }
  if (!name) {
    throw new Error('--name is required');
  }
  if (!STAFF_ROLES.includes(role)) {
    throw new Error(`--role must be one of: ${STAFF_ROLES.join(', ')}`);
  }
  return { email, name, role };
}

/** `randomInt` (not `Math.random`) - this value is a real credential. */
function generateTempPassword(): string {
  let out = '';
  for (let i = 0; i < PASSWORD_LENGTH; i += 1) {
    out += PASSWORD_ALPHABET[randomInt(PASSWORD_ALPHABET.length)];
  }
  return out;
}

function resolveDatabaseUrl(): string {
  const fromEnv = process.env.DATABASE_URL;
  if (fromEnv) return fromEnv;
  let raw: string;
  try {
    raw = readFileSync(DEV_ENV_PATH, 'utf8');
  } catch {
    throw new Error('DATABASE_URL is not set and .secrets/dev.env is unreadable');
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    const eq = trimmed.indexOf('=');
    if (eq > 0 && trimmed.slice(0, eq).trim() === 'DATABASE_URL') {
      return trimmed.slice(eq + 1).trim();
    }
  }
  throw new Error('No DATABASE_URL found');
}

function resolveKeyRingPath(): string {
  const fromEnv = process.env.WP_KEY_RING_PATH;
  if (fromEnv) return fromEnv;
  throw new Error(
    'WP_KEY_RING_PATH must be set - the TOTP secret is sealed with the real key ring, never a fixture',
  );
}

/**
 * Serialises a `SealedBlob` to `bytea`. MUST stay byte-compatible with
 * `../modules/staff-auth/totp.ts`'s `bytesToSealedBlob` -
 * this is the storage contract between the writer (here) and the reader
 * (the login path). One `JSON.stringify`, no second pass.
 */
function sealedBlobToBytes(blob: {
  ciphertext: Buffer;
  iv: Buffer;
  auth_tag: Buffer;
  dek_wrapped: Buffer;
  dek_iv: Buffer;
  dek_tag: Buffer;
  kek_id: string;
  enc_version: number;
}): Buffer {
  return Buffer.from(
    JSON.stringify({
      ciphertext: blob.ciphertext.toString('base64'),
      iv: blob.iv.toString('base64'),
      auth_tag: blob.auth_tag.toString('base64'),
      dek_wrapped: blob.dek_wrapped.toString('base64'),
      dek_iv: blob.dek_iv.toString('base64'),
      dek_tag: blob.dek_tag.toString('base64'),
      kek_id: blob.kek_id,
      enc_version: blob.enc_version,
    }),
    'utf8',
  );
}

async function main(): Promise<void> {
  const { email, name, role } = parseArgs(process.argv.slice(2));
  const staffId = randomUUID();
  const tempPassword = generateTempPassword();
  const totpSecret = generateSecret();

  const passwordHash = await argon2Hash(tempPassword, {
    algorithm: ARGON2ID,
    ...ARGON2_PARAMS,
  });

  const sealed = seal(Buffer.from(totpSecret, 'utf8'), {
    provider: new FileKeyProvider({
      ringPath: resolveKeyRingPath(),
      mountedPurposes: ['user-secrets'],
    }),
    purpose: 'user-secrets',
    encVersion: Number(process.env.WP_ENC_VERSION ?? '1'),
    tableName: 'staff_users',
    columnName: 'mfa_totp_secret_enc',
    // Fixed non-secret constant: `recordAad` requires a clientId, but staff
    // belong to WP, not a tenant. The real binding is `recordId` (staffId).
    clientId: 'staff_users',
    recordId: staffId,
  });

  const pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'wp-create-staff-user',
    max: 1,
  });
  try {
    await pool.query(
      `INSERT INTO staff_users
         (id, email, full_name, password_hash, role, status, mfa_totp_secret_enc, mfa_enabled_at)
       VALUES ($1, $2, $3, $4, $5, 'active', $6, now())`,
      [staffId, email, name, passwordHash, role, sealedBlobToBytes(sealed)],
    );
  } finally {
    await pool.end();
  }

  const otpauthUrl = generateURI({
    issuer: 'WP Admin',
    label: email,
    secret: totpSecret,
    period: 30,
  });

  // Printed ONCE. Neither value is stored anywhere in plaintext, and there
  // is no way to recover them - a lost password means running the reset SQL
  // in docs/RUNBOOK.md, a lost TOTP secret means recreating the account.
  process.stdout.write(
    [
      '',
      'Staff account created. THESE VALUES ARE SHOWN ONCE - hand them over securely.',
      `  staff id:      ${staffId}`,
      `  email:         ${email}`,
      `  role:          ${role}`,
      `  temp password: ${tempPassword}`,
      `  otpauth url:   ${otpauthUrl}`,
      '',
      'TOTP is MANDATORY: this account cannot log in until the authenticator',
      'has been configured from the URL above. The first login also needs the',
      "operator to have added the staff member's network to ADMIN_IP_ALLOWED_CIDRS.",
      '',
    ].join('\n'),
  );
}

await main();

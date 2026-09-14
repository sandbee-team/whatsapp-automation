import { readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { hash as argon2Hash, type Algorithm } from '@node-rs/argon2';
import { generateSecret, generate as otpGenerate } from 'otplib';
import { seal } from '@wp/server-kit/crypto';
import { createPool } from '@wp/db';
import type { StaffRole } from '@wp/domain';
import { buildAdminApp } from '../../server.js';
import { IpAttemptWindow } from '../../modules/staff-auth/lockout.js';
import {
  UsedTotpCodes,
  sealedBlobToBytes,
  staffSealParams,
} from '../../modules/staff-auth/totp.js';
import { withStaffRoleTx, type AdminReadPool, type PlatformReadDeps } from '../platform-read.js';

/**
 * __test-support__/admin-test-support.ts (P28 Unit U4) - integration-test
 * plumbing: the `DATABASE_URL` resolver, a seeded staff user with a REAL
 * sealed TOTP secret, and a `buildAdminApp` wired for injected time.
 *
 * Lives under `src/` (not a sibling `tests/` tree) because
 * `admin/backend/tsconfig.json`'s `rootDir` is `src` - a helper outside it
 * fails `tsc -b` with TS6059/TS6307, exactly as app-backend's own
 * `platform/db/db-url.ts` header records. Test helpers may read
 * `process.env`/dotenv directly; only shipped runtime code may not.
 *
 * ARGON2 COST: these tests hash real passwords, so they pass a CHEAP
 * profile explicitly rather than the production 19456 KiB one - the
 * production defaults are never lowered to make a suite fast (that is the
 * rule app-backend's `password.ts` states); the cheap profile lives here,
 * in test-only code, where it cannot leak into a real login.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..', '..');
const DEV_ENV_PATH = path.join(REPO_ROOT, '.secrets', 'dev.env');
const ARGON2ID = 2 as Algorithm;

/** The checked-in dev key ring - carries the `user-secrets` purpose the staff TOTP secret is sealed under. */
export const TEST_KEY_RING_PATH = path.join(
  REPO_ROOT,
  'packages',
  'server-kit',
  'test',
  'fixtures',
  'key-ring.dev.json',
);

export const TEST_JWT_SECRET = 'admin-integration-test-jwt-secret-not-real-32';
export const TEST_ALLOWED_CIDRS = '127.0.0.0/8';

/** Mirrors app-backend's `resolveDatabaseUrl` exactly: a real env var wins, else parse `.secrets/dev.env`. */
export function resolveDatabaseUrl(): string {
  const fromEnv = process.env.DATABASE_URL;
  if (fromEnv) return fromEnv;

  let raw: string;
  try {
    raw = readFileSync(DEV_ENV_PATH, 'utf8');
  } catch {
    throw new Error(`No DATABASE_URL available: set it, or ensure it exists at ${DEV_ENV_PATH}.`);
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    if (trimmed.slice(0, eq).trim() === 'DATABASE_URL') return trimmed.slice(eq + 1).trim();
  }
  throw new Error(`No DATABASE_URL line found in ${DEV_ENV_PATH}.`);
}

export function createTestAdminPool() {
  return createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'wp-admin-api-test',
    max: 5,
  });
}

export interface SeededStaff {
  staffId: string;
  email: string;
  password: string;
  role: StaffRole;
  /** Base32 TOTP secret - the test generates live codes from it. */
  totpSecret: string;
}

/**
 * Seeds one staff user with a real argon2id hash and a REAL sealed TOTP
 * secret (envelope crypto, purpose `user-secrets`, same codec
 * `scripts/ops/create-staff-user.ts` writes) - so the login path under test
 * is the production path, not a stub. `mfaEnabled: false` produces the
 * "enrolment incomplete" account the `MFA_ENROLL_REQUIRED` case needs.
 */
export async function seedStaffUser(
  pool: AdminReadPool,
  input: { role: StaffRole; mfaEnabled?: boolean; emailPrefix: string },
): Promise<SeededStaff> {
  const staffId = randomUUID();
  const email = `${input.emailPrefix}-${staffId.slice(0, 8)}@staff.test`;
  const password = `pw-${randomUUID()}`;
  const passwordHash = await argon2Hash(password, {
    algorithm: ARGON2ID,
    memoryCost: 8,
    timeCost: 1,
    parallelism: 1,
  });
  const totpSecret = generateSecret();
  const sealedSecret = sealedBlobToBytes(
    seal(
      Buffer.from(totpSecret, 'utf8'),
      staffSealParams({ keyRingPath: TEST_KEY_RING_PATH, encVersion: 1 }, staffId),
    ),
  );

  await withStaffRoleTx(pool, async (db) => {
    await db.query(
      `INSERT INTO staff_users
         (id, email, full_name, password_hash, role, status, mfa_totp_secret_enc, mfa_enabled_at)
       VALUES ($1, $2, $3, $4, $5, 'active', $6, $7)`,
      [
        staffId,
        email,
        `Probe Staff ${staffId.slice(0, 8)}`,
        passwordHash,
        input.role,
        sealedSecret,
        input.mfaEnabled === false ? null : new Date(),
      ],
    );
  });

  return { staffId, email, password, role: input.role, totpSecret };
}

/**
 * A live TOTP code for `secret` at `at` - the real algorithm, so a
 * wrong-code case is genuinely wrong. otplib's `epoch` option is SECONDS,
 * not milliseconds: passing `Date.now()` generates a code for a completely
 * different time step and fails verification every time (the same trap
 * app-backend's `contacts-routes-mfa-support.ts` documents).
 */
export async function totpCodeFor(secret: string, at: Date): Promise<string> {
  return otpGenerate({ secret, period: 30, epoch: Math.floor(at.getTime() / 1000) });
}

export interface TestAppHandles {
  app: FastifyInstance;
  pool: ReturnType<typeof createTestAdminPool>;
  read: PlatformReadDeps;
  defects: Array<Record<string, unknown>>;
  /** Mutable clock - every service reads it through `now()`, so a test moves time without sleeping. */
  clock: { current: Date };
  close: () => Promise<void>;
}

/**
 * Builds the REAL admin app against a real pool, with an INJECTED clock and
 * a captured defect log. Time is injected rather than slept on: the
 * two-minute access-token expiry test asserts exact behaviour at +119 s and
 * +121 s, which a wall-clock test could only approximate (and would make
 * ambient-load-dependent - forbidden by core-invariants.md).
 */
export async function buildTestAdminApp(overrides?: {
  allowedCidrs?: string;
  accessTokenTtlSeconds?: number;
  trustProxy?: boolean;
}): Promise<TestAppHandles> {
  const pool = createTestAdminPool();
  const defects: Array<Record<string, unknown>> = [];
  const clock = { current: new Date() };
  const now = (): Date => clock.current;

  const read: PlatformReadDeps = {
    pool,
    logDefect: (fields) => defects.push(fields),
  };
  const auth = { pool, jwtSecret: TEST_JWT_SECRET, now };
  const sessionTiming = {
    jwtSecret: TEST_JWT_SECRET,
    accessTokenTtlSeconds: overrides?.accessTokenTtlSeconds ?? 120,
    refreshTtlSeconds: 8 * 60 * 60,
    now,
  };

  const app = await buildAdminApp({
    read,
    auth,
    trustProxy: overrides?.trustProxy ?? false,
    staffAuth: {
      auth,
      cookieSecure: false,
      login: {
        ...read,
        ...sessionTiming,
        allowedCidrs: overrides?.allowedCidrs ?? TEST_ALLOWED_CIDRS,
        totpParams: { keyRingPath: TEST_KEY_RING_PATH, encVersion: 1 },
        totpWindow: 1,
        ipWindow: new IpAttemptWindow(),
        usedTotpCodes: new UsedTotpCodes(),
      },
      refresh: { ...read, ...sessionTiming },
    },
  });

  return {
    app,
    pool,
    read,
    defects,
    clock,
    close: async () => {
      await app.close();
      await pool.end();
    },
  };
}

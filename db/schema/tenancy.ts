import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { bpchar2, bytea, citext } from './custom-types.js';
import {
  clientOnboardingStepEnum,
  clientStatusEnum,
  membershipRoleEnum,
  userStatusEnum,
} from './enums.js';

/**
 * Drizzle mirrors of `db/migrations/0002_tenancy.sql` - tenancy core. IDs are
 * app-generated uuidv7, so `uuid('id').primaryKey()` carries no DB default
 * here (matches the migration). No `instance_grants` table (ADR 0017 S5).
 */

export const plans = pgTable('plans', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  // P28 (admin-internal-api-and-panel) Unit U1, migration 0070. `key` is
  // the stable catalogue key ('starter'/'growth'/'business'); its
  // uniqueness (`plans_key_uq`) and the "exactly one is_default"
  // uniqueness (`plans_one_default_uq`) are both PARTIAL unique indexes,
  // not expressible as plain Drizzle column constraints - see the
  // migration for the exact DDL.
  key: text('key'),
  description: text('description'),
  isDefault: boolean('is_default').notNull().default(false),
});

export const planLimits = pgTable(
  'plan_limits',
  {
    planId: uuid('plan_id')
      .primaryKey()
      .references(() => plans.id),
    maxConnectedInstances: integer('max_connected_instances').notNull(),
    maxRegisteredInstances: integer('max_registered_instances').notNull(),
    maxBroadcastRecipients: integer('max_broadcast_recipients').notNull().default(20000),
    // P20 (contacts-and-import) Unit U1, migration 0060.
    maxContacts: integer('max_contacts').notNull().default(25000),
  },
  (table) => [
    check('plan_limits_max_connected_instances_positive', sql`${table.maxConnectedInstances} > 0`),
    check(
      'plan_limits_max_registered_gte_connected',
      sql`${table.maxRegisteredInstances} >= ${table.maxConnectedInstances}`,
    ),
  ],
);

export const users = pgTable('users', {
  id: uuid('id').primaryKey(),
  fullName: text('full_name').notNull(),
  email: citext('email').notNull().unique(),
  phoneE164: text('phone_e164'),
  phoneVerifiedAt: timestamp('phone_verified_at', { withTimezone: true }),
  status: userStatusEnum('status').notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  // P04a (auth-signup-and-onboarding) additions, migration 0013.
  emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
  passwordHash: text('password_hash'), // argon2id; NULL allowed (passkey-only future)
  passwordUpdatedAt: timestamp('password_updated_at', { withTimezone: true }),
  mfaTotpSecretEnc: bytea('mfa_totp_secret_enc'), // envelope-encrypted, never plaintext
  mfaEnabledAt: timestamp('mfa_enabled_at', { withTimezone: true }),
  failedLoginCount: integer('failed_login_count').notNull().default(0),
  lockedUntil: timestamp('locked_until', { withTimezone: true }),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  tokenEpoch: integer('token_epoch').notNull().default(0), // Postgres is the authority; Redis is only a cache
});

export const clients = pgTable('clients', {
  id: uuid('id').primaryKey(),
  companyName: text('company_name').notNull(),
  slug: citext('slug').notNull().unique(),
  status: clientStatusEnum('status').notNull().default('pending_verification'),
  timezone: text('timezone').notNull().default('Asia/Kolkata'),
  planId: uuid('plan_id').references(() => plans.id),
  onboardingStep: clientOnboardingStepEnum('onboarding_step').notNull().default('verify_email'),
  ownerUserId: uuid('owner_user_id').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  // P04a (auth-signup-and-onboarding) additions, migration 0013.
  consentAttestedAt: timestamp('consent_attested_at', { withTimezone: true }),
  consentAttestedByUserId: uuid('consent_attested_by_user_id').references(() => users.id),
  pacingProfileKey: text('pacing_profile_key'), // NO FK: pacing_profiles does not exist until P13
  pacingProfileAcceptedAt: timestamp('pacing_profile_accepted_at', { withTimezone: true }),
  // P20 (contacts-and-import) Unit U1, migration 0060.
  countryCode: bpchar2('country_code').notNull().default('IN'),
  consentTosVersion: text('consent_tos_version'), // P29a step 10, migration 0075.
});

export const memberships = pgTable(
  'memberships',
  {
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    role: membershipRoleEnum('role').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.clientId, table.userId] }),
    uniqueIndex('memberships_one_workspace_per_user_uq').on(table.userId),
  ],
);

import { describe, expect, it } from 'vitest';
import { TOS_VERSION, TOS_VERSION_PATTERN } from '@wp/domain';
import { ONBOARDING_COPY } from '@wp/domain';
import {
  ClientNotFoundError,
  OnboardingOutOfOrderError,
  setConsent,
  type OnboardingCtx,
  type OnboardingDbClient,
} from './onboarding.service.js';

/**
 * onboarding-consent-tos.test.ts (P29a E3/C2 hardening) - unit-level (fake
 * pool/client/repo, no real Postgres) proof that `setConsent`: rolls back
 * the whole transaction when the audit insert throws AFTER the conditional
 * update succeeded, throws `OnboardingOutOfOrderError` with no audit insert
 * at all when the conditional update finds zero rows, and threads the exact
 * same `TOS_VERSION` string to both repo calls. Also pins the `TOS_VERSION`
 * shape and the frozen, exactly-six-entry `attestConsent.statements` copy
 * contract.
 *
 * This file's import chain is `@wp/domain` (pure data) and
 * `./onboarding.service.js` (imports `@wp/domain` + `./onboarding.repo.js`,
 * which only imports TYPES from `@wp/db` and a value from
 * `./provisioning.repo.js` - neither reaches `@wp/server-kit`), so no
 * `stub-wp-server-kit-env` import is needed here.
 */

interface FakeQueryCall {
  sql: string;
  params: unknown[] | undefined;
}

function makeFakeClient(): { client: OnboardingDbClient; calls: FakeQueryCall[] } {
  const calls: FakeQueryCall[] = [];
  const client: OnboardingDbClient = {
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      return { rows: [], rowCount: 0 };
    },
    release: () => {
      // no-op
    },
  };
  return { client, calls };
}

describe('setConsent transaction integrity', () => {
  it('a_throwing_audit_insert_after_a_successful_advance_rolls_back_not_commits', async () => {
    const { client, calls } = makeFakeClient();
    const ctx: OnboardingCtx = {
      pool: { connect: async () => client },
      onboardingRepo: {
        setConsentAndAdvance: async () => true,
        insertConsentAuditLog: async () => {
          throw new Error('audit insert exploded');
        },
      },
    };

    await expect(setConsent(ctx, { clientId: 'c1', userId: 'u1' })).rejects.toThrow(
      'audit insert exploded',
    );

    const sqlStatements = calls.map((c) => c.sql);
    expect(sqlStatements).toContain('ROLLBACK');
    expect(sqlStatements).not.toContain('COMMIT');
  });

  it('setConsentAndAdvance_returning_false_throws_out_of_order_and_never_inserts_audit', async () => {
    const { client } = makeFakeClient();
    let auditInsertCalled = false;
    const ctx: OnboardingCtx = {
      pool: { connect: async () => client },
      onboardingRepo: {
        setConsentAndAdvance: async () => false,
        getOnboardingStep: async () => 'choose_timezone',
        insertConsentAuditLog: async () => {
          auditInsertCalled = true;
        },
      },
    };

    await expect(setConsent(ctx, { clientId: 'c1', userId: 'u1' })).rejects.toThrow(
      OnboardingOutOfOrderError,
    );
    expect(auditInsertCalled).toBe(false);
  });

  it('setConsentAndAdvance_returning_false_for_an_unknown_client_throws_not_found', async () => {
    const { client } = makeFakeClient();
    const ctx: OnboardingCtx = {
      pool: { connect: async () => client },
      onboardingRepo: {
        setConsentAndAdvance: async () => false,
        getOnboardingStep: async () => null,
      },
    };

    await expect(setConsent(ctx, { clientId: 'missing', userId: 'u1' })).rejects.toThrow(
      ClientNotFoundError,
    );
  });

  it('the_same_tos_version_string_reaches_both_repo_calls', async () => {
    const { client } = makeFakeClient();
    const seenVersions: string[] = [];
    const ctx: OnboardingCtx = {
      pool: { connect: async () => client },
      onboardingRepo: {
        setConsentAndAdvance: async (_c, _clientId, _userId, _at, tosVersion) => {
          seenVersions.push(tosVersion);
          return true;
        },
        insertConsentAuditLog: async (_c, _clientId, _userId, tosVersion) => {
          seenVersions.push(tosVersion);
        },
      },
    };

    const result = await setConsent(ctx, { clientId: 'c1', userId: 'u1' });

    expect(result).toEqual({ step: 'connect_whatsapp' });
    expect(seenVersions).toEqual([TOS_VERSION, TOS_VERSION]);
    expect(new Set(seenVersions).size).toBe(1);
  });

  it('a_successful_advance_and_audit_insert_commits_not_rolls_back', async () => {
    const { client, calls } = makeFakeClient();
    const ctx: OnboardingCtx = {
      pool: { connect: async () => client },
      onboardingRepo: {
        setConsentAndAdvance: async () => true,
        insertConsentAuditLog: async () => {
          // succeeds
        },
      },
    };

    await setConsent(ctx, { clientId: 'c1', userId: 'u1' });

    const sqlStatements = calls.map((c) => c.sql);
    expect(sqlStatements).toContain('COMMIT');
    expect(sqlStatements).not.toContain('ROLLBACK');
  });
});

describe('TOS_VERSION shape', () => {
  it('matches_the_tos_version_pattern', () => {
    expect(TOS_VERSION_PATTERN.test(TOS_VERSION)).toBe(true);
  });

  it('rejects_shapes_that_are_not_yyyy_mm_dd', () => {
    for (const bad of [
      '2026-9-8',
      '2026/09/08',
      '09-08-2026',
      'not-a-date',
      '2026-09-08T00:00:00Z',
    ]) {
      expect(TOS_VERSION_PATTERN.test(bad)).toBe(false);
    }
  });
});

describe('ONBOARDING_COPY.wizard.attestConsent.statements contract', () => {
  const statements = ONBOARDING_COPY.wizard.attestConsent.statements;

  it('is_frozen', () => {
    expect(Object.isFrozen(statements)).toBe(true);
    expect(Object.isFrozen(ONBOARDING_COPY.wizard.attestConsent)).toBe(true);
    expect(Object.isFrozen(ONBOARDING_COPY.wizard)).toBe(true);
    expect(Object.isFrozen(ONBOARDING_COPY)).toBe(true);
  });

  it('assigning_into_the_frozen_array_is_a_no_op_in_non_strict_and_the_value_is_unchanged', () => {
    const before = [...statements];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- proving immutability, not exercising a typed API
    const mutable = statements as unknown as any[];
    try {
      mutable[0] = 'tampered';
    } catch {
      // strict-mode assignment to a frozen array throws - also acceptable.
    }
    expect([...statements]).toEqual(before);
  });

  it('has_exactly_six_entries', () => {
    expect(statements.length).toBe(6);
  });

  it('no_entry_is_empty', () => {
    for (const statement of statements) {
      expect(statement.trim().length).toBeGreaterThan(0);
    }
  });

  it('no_entry_combines_guarantee_and_deliver_or_contains_never_banned', () => {
    for (const statement of statements) {
      const lower = statement.toLowerCase();
      const hasGuaranteeAndDeliver = lower.includes('guarantee') && lower.includes('deliver');
      expect(hasGuaranteeAndDeliver).toBe(false);
      expect(lower.includes('never banned')).toBe(false);
    }
  });
});

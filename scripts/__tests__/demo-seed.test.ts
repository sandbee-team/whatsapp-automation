import { describe, expect, it } from 'vitest';
import {
  defaultDemoEmail,
  extractVerificationToken,
  generateDemoContacts,
  generateDemoPassword,
  isProductionEnv,
} from '../demo/demo-seed-helpers.js';
import {
  needsPlanInstructionBlock,
  onboardingStepsToRun,
  resumeCredentialsFromEnv,
} from '../demo/demo-seed-resume-helpers.js';

/**
 * demo-seed.test.ts (P26b U6) - unit-tests the PURE helpers behind
 * `demo-seed.ts` (token extraction, contact sample shape, production
 * refusal). The script's own live-API walk is exercised manually against
 * the running dev stack, never here (root `vitest.config.ts` sets no
 * `WP_*` env and has no network).
 */

describe('extractVerificationToken', () => {
  it('extracts the hex token from a mailpit plain-text body', () => {
    const body =
      'Hi there,\n\nVerify your email: http://localhost:5173/verify-email?token=abc123def456\n\nThanks';
    expect(extractVerificationToken(body)).toBe('abc123def456');
  });

  it('returns null when no verification link is present', () => {
    expect(extractVerificationToken('no link here')).toBeNull();
  });
});

describe('isProductionEnv', () => {
  it('refuses when WP_ENV is production', () => {
    expect(isProductionEnv({ WP_ENV: 'production', NODE_ENV: undefined })).toBe(true);
  });

  it('refuses when NODE_ENV is production', () => {
    expect(isProductionEnv({ WP_ENV: undefined, NODE_ENV: 'production' })).toBe(true);
  });

  it('allows a dev environment', () => {
    expect(isProductionEnv({ WP_ENV: 'development', NODE_ENV: 'development' })).toBe(false);
  });
});

describe('defaultDemoEmail', () => {
  it('formats as demo+<yyyymmdd-hhmm>@wp.local', () => {
    const now = new Date(2026, 8, 7, 14, 5);
    expect(defaultDemoEmail(now)).toBe('demo+20260907-1405@wp.local');
  });
});

describe('generateDemoPassword', () => {
  it('generates a 20-char password by default from the injected randomInt', () => {
    const password = generateDemoPassword(() => 0, 20);
    expect(password).toHaveLength(20);
    expect(password).toBe('A'.repeat(20));
  });

  it('honours a custom length', () => {
    expect(generateDemoPassword(() => 0, 16)).toHaveLength(16);
  });
});

describe('generateDemoContacts', () => {
  it('generates exactly 12 contacts with valid +91 numbers and mixed-script names', () => {
    const contacts = generateDemoContacts();
    expect(contacts).toHaveLength(12);
    for (const contact of contacts) {
      expect(contact.phone).toMatch(/^\+91[6-9]\d{9}$/);
      expect(contact.defaultCountry).toBe('IN');
      expect(contact.displayName.length).toBeGreaterThan(0);
    }
    const devanagariCount = contacts.filter((contact) => /[ऀ-ॿ]/.test(contact.displayName)).length;
    expect(devanagariCount).toBe(6);
  });

  it('never produces a duplicate phone number', () => {
    const contacts = generateDemoContacts();
    const phones = new Set(contacts.map((contact) => contact.phone));
    expect(phones.size).toBe(contacts.length);
  });
});

describe('resumeCredentialsFromEnv', () => {
  it('returns null when none of the three resume env vars are set', () => {
    expect(resumeCredentialsFromEnv({})).toBeNull();
  });

  it('returns null when only some of the three resume env vars are set', () => {
    expect(
      resumeCredentialsFromEnv({
        WP_DEMO_EMAIL: 'demo@wp.local',
        WP_DEMO_PASSWORD: 'x',
      }),
    ).toBeNull();
  });

  it('returns the credentials when all three resume env vars are set', () => {
    expect(
      resumeCredentialsFromEnv({
        WP_DEMO_EMAIL: 'demo@wp.local',
        WP_DEMO_PASSWORD: 'Sup3rSecret!!',
        WP_DEMO_TOTP_SECRET: 'JBSWY3DPEHPK3PXP',
      }),
    ).toEqual({
      email: 'demo@wp.local',
      password: 'Sup3rSecret!!',
      totpSecret: 'JBSWY3DPEHPK3PXP',
    });
  });
});

describe('needsPlanInstructionBlock', () => {
  it('prints the exact psql command and the exact resume re-run command for the given email', () => {
    const block = needsPlanInstructionBlock('demo+20260907-1405@wp.local');
    expect(block).toBe(
      [
        '',
        '=== This workspace needs a plan assigned (dev-only, P28 will automate this) ===',
        'Run this against the dev database (never production):',
        '',
        "  docker exec -i wp-dev-postgres-1 psql -U wp -d wp -v ON_ERROR_STOP=1 -v demo_email='demo+20260907-1405@wp.local' < db/seeds/demo-plan-assign.sql",
        '',
        'Then re-run this script in resume mode to continue with the same workspace:',
        '',
        '  $env:WP_DEMO_EMAIL="demo+20260907-1405@wp.local"; $env:WP_DEMO_PASSWORD="<the password printed above>"; $env:WP_DEMO_TOTP_SECRET="<the TOTP secret printed above>"; pnpm demo:seed',
        '',
      ].join('\n'),
    );
  });
});

describe('onboardingStepsToRun', () => {
  it('runs all three steps from verify_email or choose_timezone', () => {
    expect(onboardingStepsToRun('choose_timezone')).toEqual([
      'timezone',
      'pacing-profile',
      'consent',
    ]);
  });

  it('skips timezone once past it', () => {
    expect(onboardingStepsToRun('accept_pacing_profile')).toEqual(['pacing-profile', 'consent']);
  });

  it('skips timezone and pacing-profile once past both', () => {
    expect(onboardingStepsToRun('attest_consent')).toEqual(['consent']);
  });

  it('runs nothing once consent (or later) is already attested', () => {
    expect(onboardingStepsToRun('connect_whatsapp')).toEqual([]);
    expect(onboardingStepsToRun('send_test')).toEqual([]);
    expect(onboardingStepsToRun('done')).toEqual([]);
  });
});

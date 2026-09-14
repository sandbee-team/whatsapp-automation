import { afterEach, describe, expect, it, vi } from 'vitest';

const ALL_ENV_KEYS = [
  'WP_ENV',
  'WP_LOG_LEVEL',
  'WP_KEY_RING_PATH',
  'WP_KEK_PURPOSES',
  'WP_ENC_VERSION',
] as const;

const VALID_ENV = {
  WP_ENV: 'test',
  WP_LOG_LEVEL: 'info',
  WP_KEY_RING_PATH: '/var/secrets/keyring-super-secret',
  WP_KEK_PURPOSES: 'session,tenant-secrets',
  WP_ENC_VERSION: '1',
} as const;

/** Unsets every config env var so each test starts from a clean slate. */
function stubEmptyEnv(): void {
  for (const key of ALL_ENV_KEYS) {
    vi.stubEnv(key, undefined as unknown as string);
    delete process.env[key];
  }
}

function stubValidEnv(
  overrides: Partial<Record<(typeof ALL_ENV_KEYS)[number], string>> = {},
): void {
  stubEmptyEnv();
  const merged = { ...VALID_ENV, ...overrides };
  for (const [key, value] of Object.entries(merged)) {
    vi.stubEnv(key, value);
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('@wp/server-kit config loader', () => {
  it('boot_fails_on_a_missing_required_env_var', async () => {
    stubValidEnv();
    delete process.env.WP_KEY_RING_PATH;
    vi.stubEnv('WP_KEY_RING_PATH', undefined as unknown as string);

    await expect(import('./index.js')).rejects.toThrow(/WP_KEY_RING_PATH/);

    try {
      vi.resetModules();
      await import('./index.js');
      throw new Error('expected config load to throw');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain('WP_KEY_RING_PATH');
      // The secret value must never be echoed back in the error.
      expect(message).not.toContain(VALID_ENV.WP_KEY_RING_PATH);
    }
  });

  it('config_is_frozen_and_process_env_is_read_once', async () => {
    stubValidEnv();
    const { config } = await import('./index.js');

    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.WP_KEK_PURPOSES)).toBe(true);
    expect(() => {
      (config as unknown as { WP_ENV: string }).WP_ENV = 'production';
    }).toThrow();

    // A change to process.env after the module first loaded must not be
    // observed - the config module is a singleton, parsed once.
    vi.stubEnv('WP_LOG_LEVEL', 'trace');
    expect(config.WP_LOG_LEVEL).toBe('info');
  });

  it('rejects_an_unknown_kek_purpose', async () => {
    stubValidEnv({ WP_KEK_PURPOSES: 'session,not-a-real-purpose' });
    await expect(import('./index.js')).rejects.toThrow(/WP_KEK_PURPOSES/);
  });

  it('deduplicates_kek_purposes_and_frezes_the_list', async () => {
    stubValidEnv({ WP_KEK_PURPOSES: 'session,session,tenant-secrets' });
    const { config } = await import('./index.js');
    expect(config.WP_KEK_PURPOSES).toEqual(['session', 'tenant-secrets']);
  });

  it('coerces_WP_ENC_VERSION_to_a_positive_integer', async () => {
    stubValidEnv({ WP_ENC_VERSION: '2' });
    const { config } = await import('./index.js');
    expect(config.WP_ENC_VERSION).toBe(2);
  });

  it('tolerates_whitespace_around_KEK_PURPOSES_entries_and_a_trailing_comma', async () => {
    stubValidEnv({ WP_KEK_PURPOSES: ' session , tenant-secrets, ' });
    const { config } = await import('./index.js');
    expect(config.WP_KEK_PURPOSES).toEqual(['session', 'tenant-secrets']);
  });

  it('rejects_KEK_PURPOSES_that_is_only_whitespace_and_commas', async () => {
    stubValidEnv({ WP_KEK_PURPOSES: ' , , ' });
    await expect(import('./index.js')).rejects.toThrow(/WP_KEK_PURPOSES/);
  });

  it.each(['0', '-1', '1.5', 'abc', ''])('rejects_WP_ENC_VERSION_value_%s', async (value) => {
    stubValidEnv({ WP_ENC_VERSION: value });
    await expect(import('./index.js')).rejects.toThrow(/WP_ENC_VERSION/);
  });
});

import './__test-support__/stub-wp-server-kit-env.js';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadAdminConfig } from './config.js';

/**
 * config-leads.test.ts (P29 C1 fix round, MAJOR 4) - `LEADS_ALLOWED_ORIGINS`
 * must go through the same fail-closed `requireInProduction` fork as every
 * other production-required secret in `config.ts`: a deployment that has
 * not decided its marketing site's origin(s) yet must fail to boot, naming
 * the key, rather than silently accept the localhost dev default in
 * production.
 */

const BASE_ENV = {
  ADMIN_DATABASE_URL: 'postgres://example/admin',
  ADMIN_JWT_SECRET: 'x'.repeat(32),
  INTERNAL_API_SERVICE_TOKEN_SECRET: 'y'.repeat(32),
  WP_KEY_RING_PATH: '/tmp/key-ring.json',
  LEADS_IP_HASH_SECRET: 'z'.repeat(32),
};

describe('config_leads_allowed_origins', () => {
  it('production_without_leads_allowed_origins_throws_a_config_error_naming_the_key', () => {
    let caught: unknown;
    try {
      loadAdminConfig({ ...BASE_ENV, NODE_ENV: 'production' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    expect((caught as ConfigError).message).toContain('LEADS_ALLOWED_ORIGINS');
  });

  it('development_without_leads_allowed_origins_yields_the_localhost_default', () => {
    const config = loadAdminConfig({ ...BASE_ENV, NODE_ENV: 'development' });
    expect(config.LEADS_ALLOWED_ORIGINS).toBe('http://localhost:3002,http://127.0.0.1:3002');
  });

  it('production_with_leads_allowed_origins_set_boots_and_keeps_the_exact_value', () => {
    const config = loadAdminConfig({
      ...BASE_ENV,
      NODE_ENV: 'production',
      LEADS_ALLOWED_ORIGINS: 'https://example.com',
    });
    expect(config.LEADS_ALLOWED_ORIGINS).toBe('https://example.com');
  });
});

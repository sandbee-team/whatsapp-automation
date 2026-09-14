import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

/**
 * config.test.ts (P08 U6b, role boot smoke) - `ROLE` accepts
 * `'session-worker'` (P08 U6b's new role) alongside the existing `'api'` |
 * `'migrate'`, and `ENC_VERSION` parses with its documented default.
 */
describe('loadConfig - ROLE / ENC_VERSION (P08 U6b)', () => {
  it('accepts_role_session_worker', () => {
    const config = loadConfig({ ROLE: 'session-worker', NODE_ENV: 'test' });
    expect(config.ROLE).toBe('session-worker');
  });

  it('rejects_an_unknown_role', () => {
    expect(() => loadConfig({ ROLE: 'not-a-real-role', NODE_ENV: 'test' })).toThrow();
  });

  it('enc_version_defaults_to_1', () => {
    const config = loadConfig({ NODE_ENV: 'test' });
    expect(config.ENC_VERSION).toBe(1);
  });

  it('enc_version_is_coerced_from_a_numeric_string', () => {
    const config = loadConfig({ ENC_VERSION: '3', NODE_ENV: 'test' });
    expect(config.ENC_VERSION).toBe(3);
  });
});

describe('loadConfig - SAFETY_POLL_MS (P11 Unit U5, step 8)', () => {
  it('the_safety_poll_cannot_be_configured_to_zero_or_above_sixty_seconds', () => {
    expect(() => loadConfig({ SAFETY_POLL_MS: '0', NODE_ENV: 'test' })).toThrow();
    expect(() => loadConfig({ SAFETY_POLL_MS: '60001', NODE_ENV: 'test' })).toThrow();
    expect(() => loadConfig({ SAFETY_POLL_MS: '-5', NODE_ENV: 'test' })).toThrow();
  });

  it('safety_poll_ms_defaults_to_30_000', () => {
    const config = loadConfig({ NODE_ENV: 'test' });
    expect(config.SAFETY_POLL_MS).toBe(30_000);
  });

  it('accepts_the_exact_60_000_ceiling', () => {
    const config = loadConfig({ SAFETY_POLL_MS: '60000', NODE_ENV: 'test' });
    expect(config.SAFETY_POLL_MS).toBe(60_000);
  });
});

describe('loadConfig - metrics listener knobs (P25 U2, step 3)', () => {
  it('metrics_listener_defaults_are_loopback_and_9464', () => {
    const config = loadConfig({ NODE_ENV: 'test' });
    expect(config.WP_METRICS_BIND).toBe('127.0.0.1');
    expect(config.WP_METRICS_PORT).toBe(9464);
  });

  it('rejects_a_metrics_port_outside_the_valid_range', () => {
    expect(() => loadConfig({ WP_METRICS_PORT: '70000', NODE_ENV: 'test' })).toThrow();
  });

  it('rollup_collector_never_runs_faster_than_five_minutes', () => {
    expect(() => loadConfig({ WP_METRIC_ROLLUP_INTERVAL_S: '30', NODE_ENV: 'test' })).toThrow();

    const atFloor = loadConfig({ WP_METRIC_ROLLUP_INTERVAL_S: '300', NODE_ENV: 'test' });
    expect(atFloor.WP_METRIC_ROLLUP_INTERVAL_S).toBe(300);

    const aboveFloor = loadConfig({ WP_METRIC_ROLLUP_INTERVAL_S: '900', NODE_ENV: 'test' });
    expect(aboveFloor.WP_METRIC_ROLLUP_INTERVAL_S).toBe(900);
  });

  it('rollup_interval_defaults_to_300', () => {
    const config = loadConfig({ NODE_ENV: 'test' });
    expect(config.WP_METRIC_ROLLUP_INTERVAL_S).toBe(300);
  });
});

describe('loadConfig - ROLE=relay + relay tick/backpressure knobs (P15 U4, step 5)', () => {
  it('accepts_role_relay', () => {
    const config = loadConfig({ ROLE: 'relay', NODE_ENV: 'test' });
    expect(config.ROLE).toBe('relay');
  });

  it('relay_tick_ms_defaults_to_500', () => {
    const config = loadConfig({ NODE_ENV: 'test' });
    expect(config.RELAY_TICK_MS).toBe(500);
  });

  it('relay_cleanup_tick_ms_defaults_to_60_000', () => {
    const config = loadConfig({ NODE_ENV: 'test' });
    expect(config.RELAY_CLEANUP_TICK_MS).toBe(60_000);
  });

  it('outbox_backpressure_depth_threshold_defaults_to_50_000', () => {
    const config = loadConfig({ NODE_ENV: 'test' });
    expect(config.OUTBOX_BACKPRESSURE_DEPTH_THRESHOLD).toBe(50_000);
  });
});

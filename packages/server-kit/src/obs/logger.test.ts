import { Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LogFields } from './log-fields.js';

/**
 * Same "stub every required config env var, then reset modules and
 * dynamic-import" pattern as `../config/config.test.ts` - the config module
 * throws at import time if any of these are missing, and `logger.ts` reads
 * `config.WP_LOG_LEVEL` at module load.
 */
function stubValidEnv(): void {
  vi.stubEnv('WP_ENV', 'test');
  vi.stubEnv('WP_LOG_LEVEL', 'info');
  vi.stubEnv('WP_KEY_RING_PATH', '/tmp/dummy-keyring-path');
  vi.stubEnv('WP_KEK_PURPOSES', 'session');
  vi.stubEnv('WP_ENC_VERSION', '1');
}

/**
 * A synchronous in-memory `Writable` used as an injectable pino destination
 * in place of stdout, so assertions can read the captured lines immediately
 * after a log call without racing an async flush.
 */
function createCaptureStream(): { stream: Writable; lines: () => unknown[] } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  return {
    stream,
    lines: () =>
      chunks
        .join('')
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as unknown),
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('@wp/server-kit obs logger', () => {
  it('a_non_allow_listed_field_is_dropped', async () => {
    stubValidEnv();
    const { createLogger } = await import('./logger.js');
    const { stream, lines } = createCaptureStream();
    const testLogger = createLogger(stream);

    // Sentinel values for every hard-redacted key, cast through `unknown` to
    // simulate a caller that bypasses the `LogFields` type check (the
    // runtime filter must catch this regardless of what the type allowed).
    const forbiddenFields = {
      recipient: 'SENTINEL_RECIPIENT_919999999999',
      body: 'SENTINEL_BODY_TEXT',
      payload: 'SENTINEL_PAYLOAD_VALUE',
      creds: 'SENTINEL_CREDS_VALUE',
      token: 'SENTINEL_TOKEN_VALUE',
      authorization: 'SENTINEL_AUTHORIZATION_VALUE',
      qr: 'SENTINEL_QR_VALUE',
    } as unknown as LogFields;

    testLogger.info(
      { ...forbiddenFields, request_id: 'req-123', client_id: 'client-abc' },
      'test message',
    );

    const output = JSON.stringify(lines());

    for (const sentinelValue of [
      'SENTINEL_RECIPIENT_919999999999',
      'SENTINEL_BODY_TEXT',
      'SENTINEL_PAYLOAD_VALUE',
      'SENTINEL_CREDS_VALUE',
      'SENTINEL_TOKEN_VALUE',
      'SENTINEL_AUTHORIZATION_VALUE',
      'SENTINEL_QR_VALUE',
    ]) {
      expect(output).not.toContain(sentinelValue);
    }

    for (const forbiddenKey of [
      'recipient',
      'body',
      'payload',
      'creds',
      'token',
      'authorization',
      'qr',
    ]) {
      expect(output).not.toContain(forbiddenKey);
    }

    // Allow-listed fields must still make it through untouched.
    expect(output).toContain('req-123');
    expect(output).toContain('client-abc');
  });

  it('drops_a_key_that_is_simply_not_on_the_allow_list', async () => {
    stubValidEnv();
    const { createLogger } = await import('./logger.js');
    const { stream, lines } = createCaptureStream();
    const testLogger = createLogger(stream);

    const withUnknownKey = {
      request_id: 'req-456',
      not_an_allow_listed_field: 'SENTINEL_UNKNOWN_KEY_VALUE',
    } as unknown as LogFields;

    testLogger.info(withUnknownKey, 'another message');

    const output = JSON.stringify(lines());
    expect(output).not.toContain('SENTINEL_UNKNOWN_KEY_VALUE');
    expect(output).not.toContain('not_an_allow_listed_field');
    expect(output).toContain('req-456');
  });

  it('reads_the_level_from_config_and_has_no_per_session_child_method', async () => {
    stubValidEnv();
    vi.stubEnv('WP_LOG_LEVEL', 'warn');
    const { createLogger } = await import('./logger.js');
    const { stream } = createCaptureStream();
    const testLogger = createLogger(stream);

    // ADR 0018 (memory budget): no `.child()` per-session binding is exposed
    // anywhere on the public logger surface.
    expect((testLogger as unknown as Record<string, unknown>).child).toBeUndefined();
  });

  it('exports_a_single_shared_default_logger_instance', async () => {
    stubValidEnv();
    const mod = await import('./logger.js');
    expect(mod.logger).toBeDefined();
    expect(typeof mod.logger.info).toBe('function');
  });

  it('an_allow_listed_field_given_an_object_value_is_dropped_not_smuggled_through', async () => {
    // The allow-list filters by top-level key name AND value type: only
    // `string`/`number` values are copied. `LogFields`'s own type says every
    // field is `string | number`, but that is a compile-time contract only
    // (see the module doc comment); a caller that casts through `unknown`
    // could otherwise put an object - including a `body`-shaped one - behind
    // an allow-listed key. The runtime value-type filter drops it instead of
    // passing it through unfiltered.
    stubValidEnv();
    const { createLogger } = await import('./logger.js');
    const { stream, lines } = createCaptureStream();
    const testLogger = createLogger(stream);

    const smuggled = {
      route: {
        body: 'SENTINEL_SMUGGLED_BODY',
        token: 'SENTINEL_SMUGGLED_TOKEN',
      },
      request_id: 'req-smuggle',
    } as unknown as LogFields;

    testLogger.info(smuggled, 'smuggle test');
    const output = JSON.stringify(lines());

    // The nested object value is dropped entirely - neither its keys nor its
    // values reach the log line - while sibling allow-listed primitive
    // fields still do.
    expect(output).not.toContain('SENTINEL_SMUGGLED_BODY');
    expect(output).not.toContain('SENTINEL_SMUGGLED_TOKEN');
    expect(output).not.toContain('route');
    expect(output).toContain('req-smuggle');
  });

  it('a_sensitive_looking_string_in_the_free_text_message_is_NOT_redacted_by_design', async () => {
    // The contract is: FIELDS are allow-listed/hard-redacted; the message
    // string is free text and is never scanned or redacted. Call sites are
    // responsible for never putting secrets in the message itself. Pinning
    // this here rather than assuming it.
    stubValidEnv();
    const { createLogger } = await import('./logger.js');
    const { stream, lines } = createCaptureStream();
    const testLogger = createLogger(stream);

    testLogger.info({ request_id: 'req-msg' }, 'token=SENTINEL_TOKEN_IN_MESSAGE_TEXT');
    const output = JSON.stringify(lines());

    expect(output).toContain('SENTINEL_TOKEN_IN_MESSAGE_TEXT');
  });

  it('an_error_object_is_reduced_to_a_name_and_code_summary', async () => {
    stubValidEnv();
    const { createLogger } = await import('./logger.js');
    const { stream, lines } = createCaptureStream();
    const testLogger = createLogger(stream);

    const fakePgError = Object.assign(
      new Error('duplicate key value violates unique constraint "SENTINEL_CONSTRAINT"'),
      {
        name: 'error',
        code: '23505',
        detail: 'Key (email)=(SENTINEL_PII_EMAIL) already exists.',
      },
    );

    testLogger.info({ err: fakePgError } as never, 'probe failed');

    const output = JSON.stringify(lines());
    expect(output).toContain('23505');
    expect(output).toContain('error_summary');
    expect(output).not.toContain('SENTINEL_PII_EMAIL');
    expect(output).not.toContain('SENTINEL_CONSTRAINT');
    expect(output).not.toContain('detail');
  });
});

import { describe, expect, it } from 'vitest';
import { errorEnvelopeSchema } from '@wp/contracts';
import { AppError, CryptoError } from './app-error.js';
import { toHttpEnvelope } from './to-http.js';

describe('toHttpEnvelope', () => {
  it('an_unknown_error_becomes_a_500_envelope_with_a_request_id_and_no_internal_text', () => {
    const secret = 'db password hunter2 stack trace at file.ts:42';
    const unknown = new Error(secret);

    const { status, body } = toHttpEnvelope(unknown, 'req-1');

    // Validate against the @wp/contracts envelope shape.
    const parsed = errorEnvelopeSchema.parse(body);

    expect(status).toBe(500);
    expect(parsed.error.code).toBe('INTERNAL');
    expect(parsed.error.requestId).toBe('req-1');
    expect(parsed.error.message).not.toContain(secret);
    expect(parsed.error.message).not.toContain('hunter2');
    expect(JSON.stringify(parsed)).not.toContain('stack');
  });

  it('a_crypto_error_stringifies_to_a_code_and_kek_id_only', () => {
    const err = new CryptoError('CRYPTO_DECRYPT_FAILED', 'k1');

    expect(String(err)).toBe('CRYPTO_DECRYPT_FAILED:k1');
    expect(err.message).toBe('CRYPTO_DECRYPT_FAILED:k1');
  });

  it('a_crypto_error_renders_as_500_internal_with_no_kek_id_leaked_into_the_envelope', () => {
    const err = new CryptoError('CRYPTO_DECRYPT_FAILED', 'super-secret-kek-id');

    const { status, body } = toHttpEnvelope(err, 'req-2');
    const parsed = errorEnvelopeSchema.parse(body);

    expect(status).toBe(500);
    expect(parsed.error.code).toBe('INTERNAL');
    expect(parsed.error.requestId).toBe('req-2');
    expect(JSON.stringify(parsed)).not.toContain('super-secret-kek-id');
  });

  it('an_exposed_app_error_renders_its_own_code_and_message', () => {
    const err = new AppError('VALIDATION_ERROR', 'name is required', {
      expose: true,
    });

    const { status, body } = toHttpEnvelope(err, 'req-3');
    const parsed = errorEnvelopeSchema.parse(body);

    expect(status).toBe(400);
    expect(parsed.error.code).toBe('VALIDATION_ERROR');
    expect(parsed.error.message).toBe('name is required');
    expect(parsed.error.requestId).toBe('req-3');
  });

  it('a_non_exposed_app_error_renders_a_generic_message_never_its_own', () => {
    const err = new AppError('CONFIG_INVALID', 'SMTP_HOST is not a valid hostname', {
      expose: false,
    });

    const { status, body } = toHttpEnvelope(err, 'req-4');
    const parsed = errorEnvelopeSchema.parse(body);

    expect(status).toBe(500);
    expect(parsed.error.code).toBe('INTERNAL');
    expect(parsed.error.message).not.toContain('SMTP_HOST');
  });

  it('a_kekId_containing_user_controlled_injection_like_text_never_leaks_into_the_envelope', () => {
    const maliciousKekId = '"};alert(1);//<script>SENTINEL_KEK_INJECTION</script>';
    const err = new CryptoError('CRYPTO_KEY_UNAVAILABLE', maliciousKekId);

    const { status, body } = toHttpEnvelope(err, 'req-5');
    const parsed = errorEnvelopeSchema.parse(body);

    expect(status).toBe(500);
    expect(parsed.error.code).toBe('INTERNAL');
    expect(JSON.stringify(parsed)).not.toContain('SENTINEL_KEK_INJECTION');
    // The kekId is still on the error object itself (for logs), just never
    // in the HTTP envelope.
    expect(err.kekId).toBe(maliciousKekId);
  });

  it('an_app_errors_cause_chain_is_never_serialized_into_the_envelope', () => {
    const rootCause = new Error('SENTINEL_ROOT_CAUSE_DB_CONNECTION_STRING');
    const err = new AppError('VALIDATION_ERROR', 'input rejected', {
      expose: true,
      cause: rootCause,
    });

    // `cause` is preserved on the error object itself (Node's native Error
    // cause chaining) ...
    expect(err.cause).toBe(rootCause);

    // ... but never reaches the HTTP envelope, even when the error IS
    // exposed - only `code`/`message`/`requestId` are ever rendered.
    const { body } = toHttpEnvelope(err, 'req-6');
    const parsed = errorEnvelopeSchema.parse(body);
    expect(JSON.stringify(parsed)).not.toContain('SENTINEL_ROOT_CAUSE_DB_CONNECTION_STRING');
    expect(Object.keys(parsed.error)).not.toContain('cause');
  });
});

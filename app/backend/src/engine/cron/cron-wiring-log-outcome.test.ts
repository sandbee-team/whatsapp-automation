import '../../modules/realtime/__test-support__/stub-wp-server-kit-env.js';
import { describe, expect, it, vi } from 'vitest';
import { logger } from '@wp/server-kit';
import { logOutcome } from './cron-wiring.js';

/**
 * cron-wiring-log-outcome.test.ts (P20 C1 m3) - `logOutcome`'s `db_error`
 * log line renders ONLY `error.name`/`.code`, never `.message` - a pg
 * driver error's message can carry the offending row's raw values (same
 * discipline as `error-mapper.ts#sendError`'s own unhandled-error log line).
 */

describe('logOutcome', () => {
  it('a_db_error_outcome_logs_name_and_code_never_the_message', () => {
    const spy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);

    class FakePgError extends Error {
      code = '23505';
      constructor() {
        super('duplicate key value violates unique constraint: phone_e164=+919876500000');
        this.name = 'FakePgError';
      }
    }

    logOutcome('contact-import', 'db_error', new FakePgError());

    expect(spy).toHaveBeenCalledTimes(1);
    const [, message] = spy.mock.calls[0] as [unknown, string];
    expect(message).toContain('FakePgError');
    expect(message).toContain('23505');
    expect(message).not.toContain('+919876500000');
    expect(message).not.toContain('duplicate key value');

    spy.mockRestore();
  });

  it('lock_not_acquired_and_ran_never_log', () => {
    const spy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);

    logOutcome('contact-import', 'lock_not_acquired');
    logOutcome('contact-import', 'ran');
    logOutcome('contact-import', 'skipped_overlap');

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

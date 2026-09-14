import '../../modules/realtime/__test-support__/stub-wp-server-kit-env.js';
import { describe, expect, it, vi } from 'vitest';
import { runOneAdminRelaxExpirySweep } from './admin-relax-expiry.js';

/**
 * admin-relax-expiry-error-logging.test.ts (C1 review round 2 MINOR fix) -
 * a per-row sweep failure is no longer swallowed by a silent `catch`: it is
 * logged at error level next to the `errors` counter increment. Fields are
 * `client_id`/`instance_id`/`error_class` - `@wp/server-kit`'s `LogFields`
 * allow-list (`packages/server-kit/src/obs/log-fields.ts`) has no
 * `overrideId` field, so (same idiom as `warmup-evaluator.ts`'s own per-row
 * catch) the override id and the error message are folded into the log
 * MESSAGE string instead. Pure unit test (mocked `pool`/`tenantDb`/`logger`)
 * - no real Postgres needed to prove the log call shape deterministically.
 */

describe('runOneAdminRelaxExpirySweep error logging', () => {
  it('logs_client_id_and_instance_id_fields_plus_the_overrideId_and_message_in_the_log_line_next_to_the_counter_increment', async () => {
    const boom = new Error('withTenant exploded');
    const pool = {
      query: vi.fn().mockResolvedValue({
        rows: [{ id: 'override-1', client_id: 'client-1', instance_id: 'instance-1' }],
        rowCount: 1,
      }),
    };
    const tenantDb = { withTenant: vi.fn().mockRejectedValue(boom) };
    const errorLog = vi.fn();

    const outcome = await runOneAdminRelaxExpirySweep({
      pool,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal mock, real shape asserted via call args below
      tenantDb: tenantDb as any,
      clock: { now: () => Date.now() },
      logger: { error: errorLog },
    });

    expect(outcome.errors).toBe(1);
    expect(outcome.expired).toBe(0);
    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(errorLog).toHaveBeenCalledWith(
      { client_id: 'client-1', instance_id: 'instance-1', error_class: 'Error' },
      'admin-relax-expiry sweep: override override-1 failed to re-resolve: withTenant exploded',
    );
  });

  it('logs_error_class_from_the_thrown_errors_own_name_not_a_hardcoded_string', async () => {
    class WalletFrozenError extends Error {
      override readonly name = 'WalletFrozenError';
    }
    const boom = new WalletFrozenError('wallet frozen mid-resolve');
    const pool = {
      query: vi.fn().mockResolvedValue({
        rows: [{ id: 'override-2', client_id: 'client-2', instance_id: 'instance-2' }],
        rowCount: 1,
      }),
    };
    const tenantDb = { withTenant: vi.fn().mockRejectedValue(boom) };
    const errorLog = vi.fn();

    const outcome = await runOneAdminRelaxExpirySweep({
      pool,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal mock, real shape asserted via call args below
      tenantDb: tenantDb as any,
      clock: { now: () => Date.now() },
      logger: { error: errorLog },
    });

    expect(outcome.errors).toBe(1);
    expect(errorLog).toHaveBeenCalledWith(
      { client_id: 'client-2', instance_id: 'instance-2', error_class: 'WalletFrozenError' },
      'admin-relax-expiry sweep: override override-2 failed to re-resolve: wallet frozen mid-resolve',
    );
  });
});

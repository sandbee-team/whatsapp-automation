import { describe, expect, it, vi } from 'vitest';
import { onceForKey } from './once-per-token.js';

describe('onceForKey', () => {
  it('shares one in-flight promise across concurrent calls for the same key', async () => {
    const run = vi.fn(() => Promise.resolve('result'));

    // Simulates StrictMode's mount -> cleanup -> remount: two effect
    // invocations for the same key before the first call has settled.
    const first = onceForKey('token-a', run);
    const second = onceForKey('token-a', run);

    expect(run).toHaveBeenCalledTimes(1);
    await expect(first).resolves.toBe('result');
    await expect(second).resolves.toBe('result');
    expect(first).toBe(second);
  });

  it('does not re-run for the same key even after the first call settles', async () => {
    const run = vi.fn(() => Promise.resolve('result'));

    await onceForKey('token-b', run);
    await onceForKey('token-b', run);

    expect(run).toHaveBeenCalledTimes(1);
  });

  it('shares a rejected promise too, so a failed single-use consume is not retried', async () => {
    const run = vi.fn(() => Promise.reject(new Error('already used')));

    const first = onceForKey('token-c', run).catch((error: unknown) => error);
    const second = onceForKey('token-c', run).catch((error: unknown) => error);

    expect(run).toHaveBeenCalledTimes(1);
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toBe(secondResult);
  });

  it('runs independently for different keys', async () => {
    const run = vi.fn(() => Promise.resolve('result'));

    await onceForKey('token-d', run);
    await onceForKey('token-e', run);

    expect(run).toHaveBeenCalledTimes(2);
  });

  it('with evictOnRejection: still dedupes concurrent callers against ONE rejection', async () => {
    const run = vi.fn(() => Promise.reject(new Error('transient')));

    const first = onceForKey('token-f', run, { evictOnRejection: true }).catch(
      (error: unknown) => error,
    );
    const second = onceForKey('token-f', run, { evictOnRejection: true }).catch(
      (error: unknown) => error,
    );

    expect(run).toHaveBeenCalledTimes(1);
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toBe(secondResult);
  });

  it('with evictOnRejection: a later call for the same key retries after a rejection settles', async () => {
    const run = vi.fn(() => Promise.reject(new Error('transient')));

    await onceForKey('token-g', run, { evictOnRejection: true }).catch(() => undefined);
    await onceForKey('token-g', run, { evictOnRejection: true }).catch(() => undefined);

    expect(run).toHaveBeenCalledTimes(2);
  });

  it('without evictOnRejection (default): a later call for the same key does NOT retry', async () => {
    const run = vi.fn(() => Promise.reject(new Error('already used')));

    await onceForKey('token-h', run).catch(() => undefined);
    await onceForKey('token-h', run).catch(() => undefined);

    expect(run).toHaveBeenCalledTimes(1);
  });
});

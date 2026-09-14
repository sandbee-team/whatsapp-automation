import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { requestIdFor, sendError } from '../error-mapper.js';

/**
 * error-mapper.test.ts (P04a FIXB) - M15 (inbound x-request-id validation)
 * and M16 (unknown-throwable logging never leaks a stack/raw message).
 */

describe('requestIdFor (M15, P04a FIXB)', () => {
  it('a_valid_inbound_x_request_id_is_reused', async () => {
    const app = Fastify();
    app.get('/probe', (req, reply) => {
      reply.send({ id: requestIdFor(req) });
    });
    const response = await app.inject({
      method: 'GET',
      url: '/probe',
      headers: { 'x-request-id': 'valid-request-id-123' },
    });
    expect(response.json()).toEqual({ id: 'valid-request-id-123' });
    await app.close();
  });

  it('a_malformed_inbound_x_request_id_is_replaced_with_a_generated_one', async () => {
    const app = Fastify();
    app.get('/probe', (req, reply) => {
      reply.send({ id: requestIdFor(req) });
    });
    const response = await app.inject({
      method: 'GET',
      url: '/probe',
      headers: { 'x-request-id': 'short' },
    });
    const body = response.json() as { id: string };
    expect(body.id).not.toBe('short');
    expect(body.id.length).toBeGreaterThan(8);
    await app.close();
  });
});

describe('sendError unknown-throwable logging (M16, P04a FIXB)', () => {
  it('logs_only_requestId_name_code_never_a_stack_or_raw_message', async () => {
    const app = Fastify();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    app.get('/probe', (_req, reply) => {
      const err = new Error('super secret pg detail: password=hunter2') as Error & {
        code?: string;
      };
      err.code = '23505';
      sendError(reply, 'req-1', err);
    });

    await app.inject({ method: 'GET', url: '/probe' });

    expect(spy).toHaveBeenCalledTimes(1);
    const loggedArgs = spy.mock.calls[0]!;
    const loggedPayload = JSON.stringify(loggedArgs);
    expect(loggedPayload).not.toContain('hunter2');
    expect(loggedPayload).not.toContain('super secret pg detail');
    expect(loggedArgs[1]).toMatchObject({ requestId: 'req-1', name: 'Error', code: '23505' });

    spy.mockRestore();
    await app.close();
  });
});

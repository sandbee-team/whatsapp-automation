import { describe, expect, it, vi } from 'vitest';
import { LEADS_ENDPOINT, assertNotCustomerApi, readUtm, submitLead } from '../src/lib/leads.js';

/**
 * leads.test.ts (P29 U4b) - the contact form's write path, unit-tested
 * without a network call: `submitLead` takes a fake `fetch` (mirrors the
 * `fetchImpl` injection idiom used elsewhere in this repo for testable
 * network code).
 */

describe('leads_lib', () => {
  it('the_default_lead_endpoint_is_the_admin_public_route_not_the_customer_api', () => {
    const url = new URL(LEADS_ENDPOINT);
    expect(url.pathname).toBe('/public/v1/leads');
    expect(url.port).not.toBe('3000');
  });

  it('a_customer_api_url_is_refused', () => {
    expect(() => assertNotCustomerApi('http://127.0.0.1:3000/v1/leads')).toThrow();
    expect(() => assertNotCustomerApi('http://127.0.0.1:3001/public/v1/leads')).not.toThrow();
  });

  it('the_customer_api_origin_is_refused_even_on_the_public_v1_pathname', () => {
    expect(() => assertNotCustomerApi('http://127.0.0.1:3000/public/v1/leads')).toThrow();
    expect(() => assertNotCustomerApi('http://127.0.0.1:3001/public/v1/leads')).not.toThrow();
  });

  it('submit_lead_posts_json_without_credentials', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 202 }));

    const result = await submitLead(
      {
        name: 'Ada Lovelace',
        email: 'ada@example.com',
        message: 'hello',
        source: 'contact',
        website: '',
        startedAt: Date.now(),
      },
      fetchImpl,
    );

    expect(result).toEqual({ ok: true, status: 202 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(LEADS_ENDPOINT);
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('omit');
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.website).toBe('');
    expect(typeof body.startedAt).toBe('number');
  });

  it('utm_is_read_from_the_query_string_and_truncated', () => {
    const utm = readUtm(`?utm_source=x&foo=bar&utm_term=${'a'.repeat(300)}`);
    expect(utm).toEqual({ utm_source: 'x', utm_term: 'a'.repeat(200) });
  });
});

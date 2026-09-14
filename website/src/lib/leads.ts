/**
 * lib/leads.ts (P29 U4b) - the marketing contact form's ONLY network call.
 * Posts to admin-backend's public, unauthenticated lead endpoint
 * (`/public/v1/leads`, port 3001 in dev) - never to app-backend's
 * customer-facing `/v1/` API (port 3000). `assertNotCustomerApi` makes that
 * a runtime assertion, not just a comment: blueprint R-52 is that the
 * marketing site must never be able to reach the customer/tenant API
 * surface, however `NEXT_PUBLIC_LEADS_ENDPOINT` is configured at build time.
 */

export const LEADS_ENDPOINT =
  process.env.NEXT_PUBLIC_LEADS_ENDPOINT ?? 'http://127.0.0.1:3001/public/v1/leads';

/** Exact origins the customer/tenant API is known to run on - a URL matching any of these origins is refused regardless of pathname (see `assertNotCustomerApi`). */
const CUSTOMER_API_ORIGINS = [
  'http://127.0.0.1:3000',
  'http://localhost:3000',
  process.env.NEXT_PUBLIC_CUSTOMER_API_ORIGIN,
].filter((origin): origin is string => Boolean(origin));

/** Throws when `url` targets the customer API's origin (by exact origin match, or by port 3000) or a pathname not under the public lead-endpoint prefix - see the module header. */
export function assertNotCustomerApi(url: string): void {
  const parsed = new URL(url);
  const isCustomerApiOrigin =
    CUSTOMER_API_ORIGINS.includes(parsed.origin) || parsed.port === '3000';
  if (isCustomerApiOrigin || !parsed.pathname.startsWith('/public/v1/')) {
    throw new Error(
      `lib/leads.ts: refusing to submit to "${url}" - the lead form must only ever target /public/v1/ (never the customer API).`,
    );
  }
}

export interface LeadInput {
  name: string;
  email: string;
  company?: string;
  phoneE164?: string;
  message: string;
  source: string;
  utm?: Record<string, string>;
  /** The honeypot field - always empty for a real visitor. */
  website: string;
  /** `Date.now()` captured when the form first rendered - the bot guard's minimum-elapsed-time check. */
  startedAt: number;
}

export async function submitLead(
  input: LeadInput,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; status: number }> {
  assertNotCustomerApi(LEADS_ENDPOINT);
  const response = await fetchImpl(LEADS_ENDPOINT, {
    method: 'POST',
    credentials: 'omit',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  return { ok: response.ok, status: response.status };
}

const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'] as const;
const UTM_VALUE_MAX_LENGTH = 200;

/** Picks the standard UTM keys off a query string (with or without a leading `?`), truncating each value. */
export function readUtm(search: string): Record<string, string> {
  const params = new URLSearchParams(search);
  const out: Record<string, string> = {};
  for (const key of UTM_KEYS) {
    const value = params.get(key);
    if (value) {
      out[key] = value.slice(0, UTM_VALUE_MAX_LENGTH);
    }
  }
  return out;
}

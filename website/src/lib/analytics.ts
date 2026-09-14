/**
 * analytics.ts (P29 U2) - privacy-respecting, cookie-light, PII-free event
 * tracking. What is collected: one of a fixed set of event names, plus the
 * page PATHNAME only (query string and hash are stripped before anything
 * leaves the browser - never search, hash, email, phone, or tenant id). No
 * cookies, no localStorage, no identifiers. Sending is a no-op unless
 * `NEXT_PUBLIC_ANALYTICS_ENDPOINT` is configured; the privacy page
 * describes this in full.
 */
export const ANALYTICS_EVENTS = ['page_view', 'cta_pricing', 'cta_docs', 'lead_submitted'] as const;
export type AnalyticsEvent = (typeof ANALYTICS_EVENTS)[number];

export interface AnalyticsPayload {
  n: AnalyticsEvent;
  p: string;
}

function isAnalyticsEvent(name: string): name is AnalyticsEvent {
  return (ANALYTICS_EVENTS as readonly string[]).includes(name);
}

/** Strips everything from the first `?` or `#` - pathname only. */
function pathnameOnly(pathnameWithQuery: string): string {
  const cutIndex = pathnameWithQuery.search(/[?#]/);
  return cutIndex === -1 ? pathnameWithQuery : pathnameWithQuery.slice(0, cutIndex);
}

export function buildPayload(
  name: string,
  pathnameWithQuery: string,
): AnalyticsPayload | undefined {
  if (!isAnalyticsEvent(name)) {
    return undefined;
  }
  return { n: name, p: pathnameOnly(pathnameWithQuery) };
}

export function trackEvent(name: AnalyticsEvent): AnalyticsPayload | undefined {
  const pathnameWithQuery = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  const payload = buildPayload(name, pathnameWithQuery);
  if (payload === undefined) {
    return undefined;
  }

  const endpoint = process.env.NEXT_PUBLIC_ANALYTICS_ENDPOINT;
  if (endpoint === undefined || endpoint === '') {
    return payload;
  }

  const body = JSON.stringify(payload);
  const sent =
    typeof navigator.sendBeacon === 'function' &&
    navigator.sendBeacon(endpoint, new Blob([body], { type: 'application/json' }));
  if (!sent) {
    void fetch(endpoint, {
      method: 'POST',
      body,
      keepalive: true,
      headers: { 'content-type': 'application/json' },
    });
  }
  return payload;
}

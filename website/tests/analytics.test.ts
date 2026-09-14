import { describe, expect, it } from 'vitest';
import { buildPayload } from '../src/lib/analytics.js';

describe('analytics payload', () => {
  it('analytics_payload_carries_only_event_name_and_pathname', () => {
    expect(buildPayload('page_view', '/pricing/?email=a@b.c#x')).toStrictEqual({
      n: 'page_view',
      p: '/pricing/',
    });
  });

  it('unknown_events_are_dropped', () => {
    expect(buildPayload('signup_email', '/')).toBeUndefined();
  });
});

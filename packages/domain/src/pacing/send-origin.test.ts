import { describe, expect, it } from 'vitest';
import { EXEMPT_ORIGINS, isExemptOrigin, NON_EXEMPT_ORIGINS, SEND_ORIGINS } from './send-origin.js';

describe('send-origin', () => {
  it('campaign_and_inbox_manual_are_explicitly_non_exempt', () => {
    expect(EXEMPT_ORIGINS).not.toContain('campaign');
    expect(EXEMPT_ORIGINS).not.toContain('inbox_manual');
    expect(NON_EXEMPT_ORIGINS).toContain('campaign');
    expect(NON_EXEMPT_ORIGINS).toContain('inbox_manual');
    expect(EXEMPT_ORIGINS.length).toBe(2);
    expect(Object.isFrozen(EXEMPT_ORIGINS)).toBe(true);
  });

  it('exempt_and_non_exempt_partition_all_send_origins', () => {
    expect([...EXEMPT_ORIGINS, ...NON_EXEMPT_ORIGINS].sort()).toEqual([...SEND_ORIGINS].sort());
  });

  it('is_exempt_origin_agrees_with_the_partition_tables', () => {
    for (const origin of EXEMPT_ORIGINS) {
      expect(isExemptOrigin(origin)).toBe(true);
    }
    for (const origin of NON_EXEMPT_ORIGINS) {
      expect(isExemptOrigin(origin)).toBe(false);
    }
  });

  it('non_exempt_origins_is_frozen', () => {
    expect(Object.isFrozen(NON_EXEMPT_ORIGINS)).toBe(true);
  });
});

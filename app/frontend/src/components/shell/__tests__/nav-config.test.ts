import { describe, expect, it } from 'vitest';
import { en } from '@wp/i18n';
import { NAV_GROUPS } from '../nav-config.js';

/**
 * nav-config.test.ts (P26b U2 contract) - every `labelKey` referenced by
 * `NAV_GROUPS` (group labels and item labels) resolves to a real key in the
 * `en` catalogue, and the expected group/route shape from the contract
 * (Overview/Messaging/Audience/Settings, with `/`, `/instances`, `/messages`,
 * `/unresolved`, `/broadcasts`, `/contacts`, `/groups`,
 * `/settings/security`, `/settings/webhooks`, `/settings/api-keys`,
 * `/wallet`) is present.
 */
describe('NAV_GROUPS', () => {
  it('every_group_and_item_label_key_exists_in_the_en_catalogue', () => {
    for (const group of NAV_GROUPS) {
      expect(en).toHaveProperty(group.labelKey);
      for (const item of group.items) {
        expect(en).toHaveProperty(item.labelKey);
      }
    }
  });

  it('has_the_contract_groups_and_routes', () => {
    const routesByGroup = NAV_GROUPS.map((group) => ({
      labelKey: group.labelKey,
      routes: group.items.map((item) => item.to),
    }));

    expect(routesByGroup).toEqual([
      { labelKey: 'nav.overview', routes: ['/', '/instances'] },
      { labelKey: 'nav.messaging', routes: ['/messages', '/unresolved', '/broadcasts'] },
      { labelKey: 'nav.audience', routes: ['/contacts', '/groups'] },
      {
        labelKey: 'nav.settings',
        routes: ['/settings/security', '/settings/webhooks', '/settings/api-keys', '/wallet'],
      },
    ]);
  });

  it('every_item_has_a_unique_test_id', () => {
    const testIds = NAV_GROUPS.flatMap((group) => group.items.map((item) => item.testId));
    expect(new Set(testIds).size).toBe(testIds.length);
  });
});

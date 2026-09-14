import { Building2, Radio, ScrollText, Wallet } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { MessageKey } from '@wp/i18n';

/**
 * nav-config.ts (P28 Unit U6, step 9) - the sidebar's shared source of
 * truth, three groups per the design brief: Platform (Clients, Instances,
 * Queue & health), Money (Top-ups), Trust (Audit log).
 */
export interface NavItem {
  to: string;
  labelKey: MessageKey;
  icon: LucideIcon;
  testId: string;
}

export interface NavGroup {
  labelKey: MessageKey;
  items: NavItem[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    labelKey: 'admin.nav.platform',
    items: [
      { to: '/clients', labelKey: 'admin.nav.clients', icon: Building2, testId: 'nav-clients' },
      { to: '/instances', labelKey: 'admin.nav.instances', icon: Radio, testId: 'nav-instances' },
      { to: '/queue', labelKey: 'admin.nav.queue', icon: ScrollText, testId: 'nav-queue' },
    ],
  },
  {
    labelKey: 'admin.nav.money',
    items: [{ to: '/topups', labelKey: 'admin.nav.topups', icon: Wallet, testId: 'nav-topups' }],
  },
  {
    labelKey: 'admin.nav.trust',
    items: [{ to: '/audit', labelKey: 'admin.nav.audit', icon: ScrollText, testId: 'nav-audit' }],
  },
];

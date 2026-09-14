import {
  Contact,
  Gauge,
  KeyRound,
  MessagesSquare,
  Phone,
  Radio,
  ShieldCheck,
  Users,
  Wallet,
  Webhook,
  type LucideIcon,
} from 'lucide-react';
import type { MessageKey } from '@wp/i18n';

/**
 * nav-config.ts (P26b U2 contract) - the sidebar/mobile-nav/command-palette
 * shared source of truth. `to` is typed as `string` (not TanStack Router's
 * generated union) on purpose: the `/wallet` route does not exist yet (U5
 * builds it), and a typed-router union would reject an unknown path today -
 * every caller renders `<Link to={item.to as never}>` so this file never
 * needs editing again once `/wallet` lands.
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
    labelKey: 'nav.overview',
    items: [
      { to: '/', labelKey: 'nav.dashboard', icon: Gauge, testId: 'nav-dashboard' },
      { to: '/instances', labelKey: 'nav.instances', icon: Phone, testId: 'nav-instances' },
    ],
  },
  {
    labelKey: 'nav.messaging',
    items: [
      { to: '/messages', labelKey: 'nav.messages', icon: MessagesSquare, testId: 'nav-messages' },
      {
        to: '/unresolved',
        labelKey: 'nav.unresolved',
        icon: Radio,
        testId: 'nav-unresolved',
      },
      { to: '/broadcasts', labelKey: 'nav.broadcasts', icon: Radio, testId: 'nav-broadcasts' },
    ],
  },
  {
    labelKey: 'nav.audience',
    items: [
      { to: '/contacts', labelKey: 'nav.contacts', icon: Contact, testId: 'nav-contacts' },
      { to: '/groups', labelKey: 'nav.groups', icon: Users, testId: 'nav-groups' },
    ],
  },
  {
    labelKey: 'nav.settings',
    items: [
      {
        to: '/settings/security',
        labelKey: 'nav.security',
        icon: ShieldCheck,
        testId: 'nav-security',
      },
      {
        to: '/settings/webhooks',
        labelKey: 'nav.webhooks',
        icon: Webhook,
        testId: 'nav-webhooks',
      },
      {
        to: '/settings/api-keys',
        labelKey: 'nav.apiKeys',
        icon: KeyRound,
        testId: 'nav-api-keys',
      },
      { to: '/wallet', labelKey: 'nav.wallet', icon: Wallet, testId: 'nav-wallet' },
    ],
  },
];

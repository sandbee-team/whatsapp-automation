import type { Catalogue } from './catalogue-type.js';

/** English strings for the 2026-09-08 app shell refresh (theme/locale menus, sidebar wallet card, top bar); hi-shell-refresh.ts mirrors every key. */
export const enShellRefresh = {
  'shell.theme.trigger': 'Change theme',
  'shell.locale.trigger': 'Change language',
  'shell.locale.optionEn': 'English',
  'shell.locale.optionHi': 'हिन्दी',

  'shell.wallet.eyebrow': 'Wallet',
  'shell.wallet.addFunds': 'Add funds',
  'shell.wallet.estimateLine': 'Roughly {count} messages left at the current rate — an estimate.',

  'brand.product': 'WA Automation',
  'brand.by': 'by Sandbee',
  'brand.visitSite': 'Visit sandbee.in (opens in a new tab)',
} as const satisfies Catalogue;

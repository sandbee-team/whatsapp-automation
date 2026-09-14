import type { Catalogue } from './catalogue-type.js';

/** Hindi strings for the 2026-09-08 app shell refresh (theme/locale menus, sidebar wallet card, top bar); mirrors en-shell-refresh.ts key for key. */
export const hiShellRefresh = {
  'shell.theme.trigger': 'थीम बदलें',
  'shell.locale.trigger': 'भाषा बदलें',
  'shell.locale.optionEn': 'English',
  'shell.locale.optionHi': 'हिन्दी',

  'shell.wallet.eyebrow': 'वॉलेट',
  'shell.wallet.addFunds': 'राशि जोड़ें',
  'shell.wallet.estimateLine': 'मौजूदा दर पर लगभग {count} संदेश शेष — यह केवल एक अनुमान है।',

  'brand.product': 'WA Automation',
  'brand.by': 'Sandbee द्वारा',
  'brand.visitSite': 'sandbee.in देखें (नए टैब में खुलता है)',
} as const satisfies Catalogue;

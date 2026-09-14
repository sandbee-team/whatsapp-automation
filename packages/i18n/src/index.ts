/**
 * @wp/i18n - `en`/`hi` catalogues, plural rules, `t()`. No React import (the
 * adapter lives in `@wp/ui`); no Node builtins; no dependencies (design doc
 * `@wp/i18n` section, ADR 0007).
 */
export const packageName = '@wp/i18n' as const;

export {
  t,
  plural,
  createT,
  catalogues,
  LOCALES,
  I18N_METRIC_NAMES,
  getMissingKeyCount,
  resetMissingKeyCounter,
} from './t.js';
export type { Locale, MessageKey } from './t.js';
export type { Catalogue } from './catalogues/catalogue-type.js';
export { en } from './catalogues/en.js';
export { hi } from './catalogues/hi.js';

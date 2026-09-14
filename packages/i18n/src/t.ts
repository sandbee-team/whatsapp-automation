import { en } from './catalogues/en.js';
import { hi } from './catalogues/hi.js';
import type { Catalogue } from './catalogues/catalogue-type.js';

export type Locale = 'en' | 'hi';
export type MessageKey = keyof typeof en;

/** Every browser-visible metric name this package emits (bridged to prom-client server-side later). */
export const I18N_METRIC_NAMES = {
  missingKey: 'wp_i18n_missing_key_total', // gitleaks:allow - a Prometheus metric name, not a credential (P29a secret-scan false positive)
} as const;

/** en/hi catalogues keyed by locale, for iteration/introspection (e.g. by check scripts). */
export const catalogues = { en, hi } as const;

export const LOCALES: readonly Locale[] = ['en', 'hi'];

let missingKeyCount = 0;

/** Total number of `t()` calls (across all locales/factories) that fell back - see `wp_i18n_missing_key_total`. */
export function getMissingKeyCount(): number {
  return missingKeyCount;
}

/** Test-only reset - never called from production code. */
export function resetMissingKeyCounter(): void {
  missingKeyCount = 0;
}

const PLACEHOLDER_PATTERN = /\{(\w+)\}/g;

function interpolate(template: string, vars: Record<string, string | number> | undefined): string {
  if (!vars) return template;
  return template.replace(PLACEHOLDER_PATTERN, (match, name: string) => {
    if (Object.prototype.hasOwnProperty.call(vars, name)) {
      return String(vars[name]);
    }
    // Unknown placeholder: left literally, per spec.
    return match;
  });
}

/**
 * Factory form: builds a `t()` bound to a custom catalogue set (used by
 * tests to exercise the missing-key fallback without mutating the real `hi`
 * catalogue). Production code uses the plain `t` export below, which is
 * `createT({ en, hi })`.
 */
export function createT(
  localeCatalogues: Record<Locale, Catalogue>,
): (key: MessageKey, vars?: Record<string, string | number>, locale?: Locale) => string {
  return function boundT(
    key: MessageKey,
    vars?: Record<string, string | number>,
    locale: Locale = 'en',
  ): string {
    // `locale` is typed as a closed union, but a runtime caller (a locale
    // read from a cookie/header/query string, say) can still pass a value
    // outside it - treat anything not present in `localeCatalogues` the same
    // as "missing in the requested locale" rather than crashing on
    // `undefined[key]`.
    const localeCatalogue = localeCatalogues[locale] as Catalogue | undefined;
    const localeValue = localeCatalogue?.[key];
    if (typeof localeValue === 'string') {
      return interpolate(localeValue, vars);
    }

    // Missing in the requested locale: fall back to English.
    missingKeyCount += 1;
    const englishValue = localeCatalogues.en[key];
    if (typeof englishValue === 'string') {
      return interpolate(englishValue, vars);
    }

    // Missing in both: return the key itself, never throw.
    return key;
  };
}

export const t = createT(catalogues as Record<Locale, Catalogue>);

/** `Intl.PluralRules`-backed plural helper: `plural('en', 1, { one: '{n} item', other: '{n} items' })`. */
export function plural(
  locale: Locale,
  n: number,
  forms: Partial<Record<Intl.LDMLPluralRule, string>> & { other: string },
): string {
  const rules = new Intl.PluralRules(locale);
  const category = rules.select(n);
  const template = forms[category] ?? forms.other;
  return interpolate(template, { n });
}

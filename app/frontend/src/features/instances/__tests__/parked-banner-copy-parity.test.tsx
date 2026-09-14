// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { I18nProvider, type Locale } from '@wp/ui';
import { INSTANCE_CARD_COPY } from '@wp/domain';
import { en } from '@wp/i18n';
import { ParkedBanner } from '../components/parked-banner.js';

/**
 * parked-banner-copy-parity.test.tsx (P17 U5) - the parked string must be
 * the VERBATIM `INSTANCE_CARD_COPY.parked` domain constant. Asserted two
 * ways: (a) the `en` catalogue value itself is byte-identical to the domain
 * constant (drift guard, same idiom as `packages/i18n/test/catalogue-copy-
 * parity.test.ts`), and (b) the rendered `ParkedBanner` in `en` shows that
 * exact text. `hi` renders its own faithful translation, never asserted
 * byte-identical to the English domain constant.
 */
describe('ParkedBanner copy parity', () => {
  afterEach(() => {
    cleanup();
  });

  it('en_catalogue_parked_string_is_byte_identical_to_the_domain_constant', () => {
    expect(en['instances.card.parked']).toBe(INSTANCE_CARD_COPY.parked);
  });

  it.each<Locale>(['en', 'hi'])('renders_the_parked_banner (%s)', (locale) => {
    render(
      <I18nProvider locale={locale}>
        <ParkedBanner />
      </I18nProvider>,
    );

    const banner = screen.getByTestId('parked-banner');
    expect(banner.textContent?.length).toBeGreaterThan(0);

    if (locale === 'en') {
      expect(banner.textContent).toContain(INSTANCE_CARD_COPY.parked);
    }
  });
});

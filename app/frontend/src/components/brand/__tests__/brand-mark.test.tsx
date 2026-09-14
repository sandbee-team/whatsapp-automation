// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { I18nProvider } from '@wp/ui';
import { BrandMark } from '../brand-mark.js';

/**
 * brand-mark.test.tsx (panel-refresh spec section 9) - the brand mark links
 * out to sandbee.in in a new tab with the right accessible name, renders a
 * responsive `srcSet` logo, hides the text block at `sm`, and shows both the
 * product and "by Sandbee" lines at `lg`.
 */
describe('BrandMark', () => {
  afterEach(() => {
    cleanup();
  });

  it('links_to_sandbee_site_in_a_new_tab_with_an_accessible_name', () => {
    render(
      <I18nProvider locale="en">
        <BrandMark />
      </I18nProvider>,
    );

    const link = screen.getByTestId('brand-mark');
    expect(link.getAttribute('href')).toBe('https://sandbee.in');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(link.getAttribute('aria-label')).toBe('Visit sandbee.in (opens in a new tab)');
  });

  it('renders_a_responsive_logo_image', () => {
    render(
      <I18nProvider locale="en">
        <BrandMark />
      </I18nProvider>,
    );

    const img = screen.getByAltText('');
    expect(img.getAttribute('srcset')).toBe('/brand/logo-64.png 1x, /brand/logo-128.png 2x');
    expect(img.getAttribute('src')).toBe('/brand/logo-64.png');
  });

  it('hides_the_text_block_when_show_text_is_false', () => {
    render(
      <I18nProvider locale="en">
        <BrandMark showText={false} />
      </I18nProvider>,
    );

    expect(screen.queryByText('WA Automation')).toBeNull();
    expect(screen.queryByText('by Sandbee')).toBeNull();
  });

  it('shows_the_product_and_by_lines_at_lg', () => {
    render(
      <I18nProvider locale="en">
        <BrandMark size="lg" />
      </I18nProvider>,
    );

    expect(screen.getByText('WA Automation')).not.toBeUndefined();
    expect(screen.getByText('by Sandbee')).not.toBeUndefined();
  });

  it('appends_the_workspace_name_to_the_by_line_when_meta_is_given', () => {
    render(
      <I18nProvider locale="en">
        <BrandMark meta="Acme Textiles" />
      </I18nProvider>,
    );

    expect(screen.getByText('by Sandbee · Acme Textiles')).not.toBeUndefined();
  });

  it('renders_a_fallback_icon_instead_of_the_image_when_it_fails_to_load', () => {
    render(
      <I18nProvider locale="en">
        <BrandMark />
      </I18nProvider>,
    );

    const img = screen.getByAltText('');
    fireEvent.error(img);

    expect(screen.queryByAltText('')).toBeNull();
    expect(screen.getByTestId('brand-mark-fallback')).not.toBeUndefined();
    expect(screen.getByTestId('brand-mark')).not.toBeUndefined();
  });
});

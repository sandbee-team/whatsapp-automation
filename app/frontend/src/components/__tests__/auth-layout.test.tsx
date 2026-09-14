// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { I18nProvider } from '@wp/ui';
import { AuthLayout } from '../auth-layout.js';

/**
 * auth-layout.test.tsx (P26b U2 contract) - the split-screen chrome renders
 * the title/description/children/footer, and the brand panel's three value
 * bullets (honest copy, no delivery-speed/restriction-avoidance claims).
 */
describe('AuthLayout', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders_title_description_children_and_footer', () => {
    render(
      <I18nProvider locale="en">
        <AuthLayout title="Sign in" description="Welcome back" footer={<span>Footer link</span>}>
          <div data-testid="auth-layout-children">form</div>
        </AuthLayout>
      </I18nProvider>,
    );

    expect(screen.getByRole('heading', { name: 'Sign in' })).not.toBeUndefined();
    expect(screen.getByText('Welcome back')).not.toBeUndefined();
    expect(screen.getByTestId('auth-layout-children')).not.toBeUndefined();
    expect(screen.getByText('Footer link')).not.toBeUndefined();
  });

  it('renders_the_three_honest_value_bullets', () => {
    render(
      <I18nProvider locale="en">
        <AuthLayout title="Sign in">
          <div />
        </AuthLayout>
      </I18nProvider>,
    );

    expect(
      screen.getByText('Every message starts as a durable job - nothing is lost.'),
    ).not.toBeUndefined();
    expect(
      screen.getByText('Live health monitoring for every connected number.'),
    ).not.toBeUndefined();
    expect(
      screen.getByText('Your workspace data stays isolated from every other tenant.'),
    ).not.toBeUndefined();
  });

  it('renders_the_three_bullet_tiles_inside_a_stagger_with_increasing_delays', () => {
    render(
      <I18nProvider locale="en">
        <AuthLayout title="Sign in">
          <div />
        </AuthLayout>
      </I18nProvider>,
    );

    const bulletTexts = [
      'Every message starts as a durable job - nothing is lost.',
      'Live health monitoring for every connected number.',
      'Your workspace data stays isolated from every other tenant.',
    ];
    const delays = bulletTexts.map((text) => {
      const tile = screen.getByText(text).closest('[style]');
      expect(tile).not.toBeNull();
      return Number.parseInt((tile as HTMLElement).style.animationDelay, 10);
    });

    expect(delays[0]).toBe(0);
    expect(delays[1]).toBeGreaterThan(delays[0]!);
    expect(delays[2]).toBeGreaterThan(delays[1]!);
  });

  it('wraps_the_form_card_in_a_pop_reveal', () => {
    render(
      <I18nProvider locale="en">
        <AuthLayout title="Sign in">
          <div data-testid="auth-layout-children" />
        </AuthLayout>
      </I18nProvider>,
    );

    const card = screen.getByTestId('auth-layout-children').closest('.animate-pop-in');
    expect(card).not.toBeNull();
  });
});

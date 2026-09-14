// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { I18nProvider } from '@wp/ui';
import type { OnboardingStep } from '@wp/contracts';
import { OnboardingWizard } from '../wizard.js';

/**
 * wizard.test.tsx (P26b U2) - the `Stepper` shows the right step highlighted
 * (via `aria-current="step"`) for every `onboardingStep` value, and the
 * matching step body renders under its own carried test id.
 */
function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify({ data: body }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function stubFetch(step: OnboardingStep): void {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/v1/onboarding')) {
      return Promise.resolve(jsonResponse({ step }));
    }
    if (url.includes('/v1/events')) {
      return new Promise<Response>(() => undefined);
    }
    return Promise.resolve(jsonResponse({}));
  });
  vi.stubGlobal('fetch', fetchMock);
}

function renderWizard(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute({ component: OnboardingWizard });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ['/onboarding'] }),
  });
  render(
    <I18nProvider locale="en">
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </I18nProvider>,
  );
}

const STEP_TEST_ID: Record<OnboardingStep, string> = {
  verify_email: 'wizard-verify-email',
  choose_timezone: 'wizard-choose-timezone',
  accept_pacing_profile: 'wizard-accept-pacing-profile',
  attest_consent: 'wizard-attest-consent',
  connect_whatsapp: 'wizard-connect-whatsapp',
  send_test: 'wizard-connect-whatsapp',
  done: 'wizard-done',
};

const STEP_INDEX: Record<OnboardingStep, number> = {
  verify_email: 0,
  choose_timezone: 1,
  accept_pacing_profile: 2,
  attest_consent: 3,
  connect_whatsapp: 4,
  send_test: 4,
  done: 4,
};

describe('OnboardingWizard stepper', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each<OnboardingStep>([
    'verify_email',
    'choose_timezone',
    'accept_pacing_profile',
    'attest_consent',
    'connect_whatsapp',
  ])('shows_the_stepper_with_%s_highlighted', async (step) => {
    stubFetch(step);
    renderWizard();

    await screen.findByTestId(STEP_TEST_ID[step]);

    const currentSteps = screen
      .getAllByRole('listitem')
      .filter((item) => item.getAttribute('aria-current') === 'step');
    expect(currentSteps.length).toBe(1);

    const allSteps = screen.getAllByRole('listitem');
    expect(allSteps.indexOf(currentSteps[0]!)).toBe(STEP_INDEX[step]);
  });

  it('done_step_hides_the_stepper', async () => {
    stubFetch('done');
    renderWizard();

    await screen.findByTestId('wizard-done');
    expect(screen.queryAllByRole('listitem').length).toBe(0);
  });

  it.each<[OnboardingStep, number]>([
    ['verify_email', 1],
    ['choose_timezone', 2],
    ['accept_pacing_profile', 3],
    ['attest_consent', 4],
    ['connect_whatsapp', 5],
  ])('shows_step_%s_of_5_eyebrow', async (step, n) => {
    stubFetch(step);
    renderWizard();

    await screen.findByTestId(STEP_TEST_ID[step]);
    expect(screen.getByText(`Step ${String(n)} of 5`)).not.toBeUndefined();
  });

  it('renders_only_one_stepper_in_the_dom', async () => {
    stubFetch('choose_timezone');
    renderWizard();

    await screen.findByTestId('wizard-choose-timezone');
    // jsdom has no CSS, so a desktop+mobile stepper pair would double this count.
    expect(screen.getAllByRole('listitem').length).toBe(5);
  });

  it('done_step_renders_a_success_progress_ring', async () => {
    stubFetch('done');
    renderWizard();

    await screen.findByTestId('wizard-done');
    expect(screen.getByRole('img', { name: 'Setup complete' })).not.toBeUndefined();
  });

  it('every_motion_class_carries_a_reduced_motion_fallback', async () => {
    stubFetch('choose_timezone');
    const { container } = render(
      <I18nProvider locale="en">
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <RouterProvider
            router={createRouter({
              routeTree: createRootRoute({ component: OnboardingWizard }),
              history: createMemoryHistory({ initialEntries: ['/onboarding'] }),
            })}
          />
        </QueryClientProvider>
      </I18nProvider>,
    );
    await screen.findByTestId('wizard-choose-timezone');

    const animated = container.querySelectorAll('[class*="animate-"]');
    expect(animated.length).toBeGreaterThan(0);
    animated.forEach((element) => {
      expect(element.className).toMatch(/motion-reduce:animate-none/);
    });
  });
});

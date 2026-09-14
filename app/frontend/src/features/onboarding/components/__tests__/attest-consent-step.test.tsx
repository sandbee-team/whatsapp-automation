// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ONBOARDING_COPY } from '@wp/domain';
import { AttestConsentStep } from '../attest-consent-step.js';

/**
 * attest-consent-step.test.tsx (P29a step 10) - the consent step renders
 * the six canonical statements as an ordered list, shows the recorded ToS
 * version, and keeps submit disabled until the checkbox is checked.
 */
vi.mock('../../api.js', () => ({
  setConsent: vi.fn().mockResolvedValue({ step: 'connect_whatsapp' }),
}));

const COPY = ONBOARDING_COPY.wizard.attestConsent;

describe('AttestConsentStep', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('renders_the_six_canonical_consent_statements', () => {
    render(<AttestConsentStep onDone={() => undefined} />);

    const list = screen.getByTestId('wizard-consent-statements');
    const items = list.querySelectorAll('li');
    expect(items.length).toBe(6);
    items.forEach((item, index) => {
      expect(item.textContent).toBe(COPY.statements[index]);
    });
  });

  it('shows_the_recorded_tos_version', () => {
    render(<AttestConsentStep onDone={() => undefined} />);

    const versionLine = screen.getByTestId('wizard-consent-tos-version');
    expect(versionLine.textContent).toContain(COPY.tosVersion);
  });

  it('submit_stays_disabled_until_the_checkbox_is_checked', () => {
    render(<AttestConsentStep onDone={() => undefined} />);

    const submit = screen.getByTestId('wizard-consent-submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    const checkbox = screen.getByTestId('wizard-consent-checkbox');
    fireEvent.click(checkbox);

    expect(submit.disabled).toBe(false);
  });
});

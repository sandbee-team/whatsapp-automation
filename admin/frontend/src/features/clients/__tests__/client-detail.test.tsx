// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { ClientHeaderActions } from '../components/client-header-actions.js';
import { WalletTab } from '../components/wallet-tab.js';
import { InstanceRowActions } from '../components/instance-row-actions.js';
import { CLIENT, INSTANCE, renderWithRole } from './client-detail-fixtures.js';

/**
 * client-detail.test.tsx (P28 Unit U6, step 9) - two of the three required
 * proofs (the idempotency-key + reason proof lives in the sibling
 * `client-detail-idempotency.test.tsx`, split for the 300-line cap): every
 * mutating control requires a reason before it enables, and RBAC greys out
 * controls the role may not use.
 */
describe('every_mutating_control_requires_a_reason_before_it_enables', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('suspend dialog: primary disabled with an empty reason, enabled after >= 3 chars', async () => {
    renderWithRole('superadmin', <ClientHeaderActions clientId={CLIENT.id} status="active" />);

    fireEvent.click(await screen.findByTestId('client-detail-suspend'));
    const submit = await screen.findByTestId('staff-action-submit');
    expect((submit as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByTestId('reason-field'), { target: { value: 'ab' } });
    expect((screen.getByTestId('staff-action-submit') as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByTestId('reason-field'), { target: { value: 'valid reason' } });
    await waitFor(() => {
      expect((screen.getByTestId('staff-action-submit') as HTMLButtonElement).disabled).toBe(false);
    });
  });

  it('credit dialog: disabled until reason AND amount/kind are valid', async () => {
    renderWithRole('superadmin', <WalletTab client={CLIENT} />);

    fireEvent.click(await screen.findByTestId('client-detail-wallet-credit'));
    const submit = await screen.findByTestId('staff-action-submit');
    expect((submit as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByTestId('client-detail-wallet-credit-amount'), {
      target: { value: '5000' },
    });
    expect((screen.getByTestId('staff-action-submit') as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByTestId('reason-field'), { target: { value: 'valid reason' } });
    await waitFor(() => {
      expect((screen.getByTestId('staff-action-submit') as HTMLButtonElement).disabled).toBe(false);
    });
  });

  it('relax pacing dialog: disabled until reason AND expiry are set', async () => {
    renderWithRole('superadmin', <InstanceRowActions clientId={CLIENT.id} instance={INSTANCE} />);

    fireEvent.click(await screen.findByTestId(`instance-relax-${INSTANCE.id}`));
    const submit = await screen.findByTestId('staff-action-submit');
    expect((submit as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByTestId('reason-field'), { target: { value: 'valid reason' } });
    expect((screen.getByTestId('staff-action-submit') as HTMLButtonElement).disabled).toBe(true);

    const dialog = submit.closest('[role="dialog"]') ?? document;
    const dateInput = (dialog as HTMLElement).querySelector('input[type="datetime-local"]');
    expect(dateInput).not.toBeNull();
    fireEvent.change(dateInput as HTMLInputElement, { target: { value: '2027-01-01T00:00' } });

    await waitFor(() => {
      expect((screen.getByTestId('staff-action-submit') as HTMLButtonElement).disabled).toBe(false);
    });
  });
});

describe('controls_the_role_may_not_use_are_disabled', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('support role: suspend/freeze/credit/relax disabled', async () => {
    renderWithRole(
      'support',
      <>
        <ClientHeaderActions clientId={CLIENT.id} status="active" />
        <WalletTab client={CLIENT} />
        <InstanceRowActions clientId={CLIENT.id} instance={INSTANCE} />
      </>,
    );

    expect(
      (await screen.findByTestId('client-detail-suspend')).getAttribute('disabled'),
    ).not.toBeNull();
    expect(
      screen.getByTestId('client-detail-wallet-credit').getAttribute('disabled'),
    ).not.toBeNull();
    expect(
      screen.getByTestId('client-detail-wallet-freeze').getAttribute('disabled'),
    ).not.toBeNull();
    expect(
      screen.getByTestId(`instance-relax-${INSTANCE.id}`).getAttribute('disabled'),
    ).not.toBeNull();
  });

  it('ops role: relax + pricing disabled, suspend enabled', async () => {
    renderWithRole(
      'ops',
      <>
        <ClientHeaderActions clientId={CLIENT.id} status="active" />
        <InstanceRowActions clientId={CLIENT.id} instance={INSTANCE} />
      </>,
    );

    expect(
      (await screen.findByTestId('client-detail-suspend')).getAttribute('disabled'),
    ).toBeNull();
    expect(
      screen.getByTestId(`instance-relax-${INSTANCE.id}`).getAttribute('disabled'),
    ).not.toBeNull();
  });

  it('superadmin role: every control enabled', async () => {
    renderWithRole(
      'superadmin',
      <>
        <ClientHeaderActions clientId={CLIENT.id} status="active" />
        <WalletTab client={CLIENT} />
        <InstanceRowActions clientId={CLIENT.id} instance={INSTANCE} />
      </>,
    );

    expect(
      (await screen.findByTestId('client-detail-suspend')).getAttribute('disabled'),
    ).toBeNull();
    expect(screen.getByTestId('client-detail-wallet-credit').getAttribute('disabled')).toBeNull();
    expect(screen.getByTestId(`instance-relax-${INSTANCE.id}`).getAttribute('disabled')).toBeNull();
  });
});

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { setClientPlanInputSchema } from '@wp/contracts';
import { ClientHeaderActions } from '../components/client-header-actions.js';
import { CLIENT, okMutationResponse, renderWithRole } from './client-detail-fixtures.js';

/**
 * client-detail-change-plan.test.tsx (go-live 2026-09-14) - the change-plan
 * control had NO test, and shipped calling `adminMutate` without a method
 * while the admin-backend proxy registers the route as PUT
 * (`mutations.routes.ts`), so every plan change went to a method the proxy
 * does not serve. These two cases pin the wire contract (method + body) and
 * the picker, so the same class cannot come back silently.
 */
describe('the change-plan control', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function submitPlanChange(): Promise<{ url: string; method: string; body: unknown }[]> {
    const calls: { url: string; method: string; body: unknown }[] = [];
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: String(init?.method ?? 'GET'),
        body: init?.body ? JSON.parse(init.body as string) : undefined,
      });
      return Promise.resolve(okMutationResponse());
    });
    vi.stubGlobal('fetch', fetchMock);

    renderWithRole('superadmin', <ClientHeaderActions clientId={CLIENT.id} status="active" />);

    fireEvent.click(await screen.findByTestId('client-detail-change-plan'));
    fireEvent.change(await screen.findByTestId('reason-field'), {
      target: { value: 'moving to the growth plan' },
    });
    // The plan picker is a Base UI Select, which listens for real pointer
    // events - `fireEvent.click` opens the popup but never commits a choice,
    // so this must go through user-event.
    const user = userEvent.setup();
    await user.click(screen.getByRole('combobox'));
    await user.click(await screen.findByRole('option', { name: 'Growth' }));

    await waitFor(() => {
      expect((screen.getByTestId('staff-action-submit') as HTMLButtonElement).disabled).toBe(false);
    });
    fireEvent.click(screen.getByTestId('staff-action-submit'));

    await waitFor(() => {
      expect(calls.some((call) => call.url.includes('/plan'))).toBe(true);
    });
    return calls;
  }

  it('sends PUT to the plan route, matching the proxy that serves it', async () => {
    const calls = await submitPlanChange();
    const planCall = calls.find((call) => call.url.includes('/plan'));

    expect(planCall).toBeDefined();
    expect(planCall!.method).toBe('PUT');
    expect(planCall!.url).toContain(`/admin/v1/clients/${CLIENT.id}/plan`);
  });

  it('submits a planKey the contract accepts, never free text', async () => {
    const calls = await submitPlanChange();
    const body = calls.find((call) => call.url.includes('/plan'))!.body as {
      planKey: string;
      reason: string;
    };

    expect(body.reason).toBe('moving to the growth plan');
    expect(body.planKey).toBe('growth');
    // The picker's options come from the contract enum, so anything it can
    // submit parses - a free-text field could not promise this.
    expect(setClientPlanInputSchema.safeParse(body).success).toBe(true);
  });
});

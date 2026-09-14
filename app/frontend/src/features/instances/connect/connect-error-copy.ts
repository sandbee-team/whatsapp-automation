import type { MessageKey } from '@wp/i18n';

/**
 * connect-error-copy.ts (2026-09-08 bug fix) - the SINGLE mapping from a
 * create/link/goOnline 409 error code to the message the `ConnectSheet`
 * (and the onboarding `ConnectWhatsappStep`, which reuses the same
 * `useConnectFlow`) should show. Extracted so `handleCreateOrLinkError` and
 * `goOnline` in `useConnectFlow.ts` can never drift apart again - both call
 * this one function instead of re-deriving the code->message mapping.
 *
 * `REGISTERED_LIMIT_REACHED` is returned by the API for TWO different
 * workspace states the panel cannot tell apart (no plan assigned at all, or
 * a plan whose registered-instance limit is already used up) - so it maps
 * to the three-part `limitOrNoPlan` copy rather than the old single-line
 * "you reached your limit" message, which was actively wrong for a
 * workspace with zero numbers and no plan.
 */
export type ConnectErrorCopy =
  | { kind: 'plain'; messageKey: MessageKey }
  | { kind: 'limitOrNoPlan'; titleKey: MessageKey; bodyKey: MessageKey; helpKey: MessageKey };

export function connectErrorMessageKey(code: string): ConnectErrorCopy | null {
  if (code === 'REGISTERED_LIMIT_REACHED') {
    return {
      kind: 'limitOrNoPlan',
      titleKey: 'instances.connect.limitOrNoPlan.title',
      bodyKey: 'instances.connect.limitOrNoPlan.body',
      helpKey: 'instances.connect.limitOrNoPlan.help',
    };
  }
  if (code === 'INVALID_STATE') {
    return { kind: 'plain', messageKey: 'instances.connect.invalidState' };
  }
  return null;
}

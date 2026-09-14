import { useQuery } from '@tanstack/react-query';
import { ONBOARDING_COPY } from '@wp/domain';
import { Alert, Button, useT } from '@wp/ui';
import { Link, useNavigate } from '@tanstack/react-router';
import { useConnectFlow } from '../../instances/connect/useConnectFlow.js';
import { ConnectSheetBody } from '../../instances/connect/ConnectSheetBody.js';
import { useRealtimeConnectionState } from '../../../lib/use-realtime-connection-state.js';
import { me } from '../../auth/index.js';
import { WizardStepHeader } from '../wizard-step-header.js';

const COPY = ONBOARDING_COPY.wizard.connectWhatsapp;

/**
 * ConnectWhatsappStep (P26b U2, brief section 4) - replaces the P04b stub
 * with the real Connect flow, rendered inline (no `Sheet` chrome - the
 * wizard card already provides the frame) via `useConnectFlow` +
 * `ConnectSheetBody`, both used read-only per this unit's file scope.
 *
 * DEVIATION from the brief's literal `data-testid="connect-button"`: this
 * unit may only call `useConnectFlow`/`ConnectSheetBody`, never edit them
 * (file scope), and `ConnectSheetBody`'s own primary action for the
 * create/first stage already carries `data-testid="connect-create-button"`
 * (see `features/instances/connect/__tests__/connect-sheet-test-helpers.tsx`,
 * which clicks that exact id). Adding a second, competing id on the same
 * element is not expressible through that component's props, so this file
 * does not fork or clone it - `connect-create-button` is the real primary
 * action that starts the flow; flagged for the reviewer/owning unit rather
 * than silently renamed.
 *
 * `isCurrentStep=false` (the `send_test` step, which the backend never
 * advances past today - carried open item, not a UI fake) never mounts the
 * connect flow, only the "continue to dashboard" exit.
 *
 * Security follow-up: a connect call needs a verified two-factor session
 * (canon - see `route-policy.ts`'s `MFA_ENROLL_REQUIRED`/`MFA_REQUIRED`
 * codes), so when `me().user.mfaEnabledAt` is still `null` this renders a
 * short gate card ABOVE the connect form pointing at `/totp` - never
 * instead of the form (it stays mounted/reachable underneath once the user
 * comes back with two-factor set up and a fresh session).
 */
export function ConnectWhatsappStep({
  isCurrentStep,
}: {
  isCurrentStep: boolean;
}): React.JSX.Element {
  const t = useT();
  const navigate = useNavigate();
  const realtimeState = useRealtimeConnectionState();
  const flow = useConnectFlow({
    open: isCurrentStep,
    realtimeState: realtimeState === 'live' ? 'connected' : 'disconnected',
    t,
  });
  const meQuery = useQuery({ queryKey: ['auth', 'me'], queryFn: me });
  const mfaNotEnabled = meQuery.data?.user?.mfaEnabledAt === null;

  return (
    <div data-testid="wizard-connect-whatsapp" className="flex flex-col gap-4">
      <WizardStepHeader title={COPY.title} description={COPY.body} />

      {isCurrentStep && mfaNotEnabled ? (
        <Alert
          tone="info"
          data-testid="wizard-connect-whatsapp-mfa-gate"
          title={t('shell.wizard.connectSecureAccountTitle')}
          body={t('shell.wizard.connectSecureAccountBody')}
          action={
            <Button
              type="button"
              size="sm"
              data-testid="wizard-connect-whatsapp-mfa-setup-button"
              onClick={() => void navigate({ to: '/totp' })}
            >
              {t('instances.connect.mfaEnrol.button')}
            </Button>
          }
        />
      ) : null}

      {isCurrentStep ? (
        <div
          data-testid={
            flow.connectError?.kind === 'limitOrNoPlan'
              ? 'wizard-connect-whatsapp-limit-gate'
              : undefined
          }
        >
          <ConnectSheetBody flow={flow} />
        </div>
      ) : (
        <Alert tone="info" title={COPY.notAvailableTitle} body={COPY.notAvailableBody} />
      )}

      <Link
        to="/"
        data-testid="wizard-continue-to-dashboard"
        className="inline-flex h-9 w-fit items-center justify-center rounded-md border border-border-strong bg-surface px-4 text-sm font-medium font-ui text-fg hover:bg-surface-2"
      >
        {t('shell.wizard.continueToDashboard')}
      </Link>
    </div>
  );
}

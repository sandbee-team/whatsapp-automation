import * as React from 'react';
import { Alert, Button, useT } from '@wp/ui';
import { ApiError } from '../../../lib/api-client.js';
import { patchWebhookEndpoint } from '../api.js';

/**
 * DisabledBanner (P15 U6, step 9; U6b, step 10) - shown on an
 * `endpoint-list.tsx` row when `enabled: false`.
 * `disabledReason === 'consecutive_failures'` states the fact plainly
 * (auto-disabled after 20 straight failures) and points at the fix
 * (re-enable once the endpoint is working); any other/absent reason falls
 * back to a generic "currently disabled" line. Tone (`danger` badge) is
 * never the ONLY signal - text always accompanies it.
 *
 * The re-enable button issues `PATCH /v1/webhooks/endpoints/{id}` with
 * `{ enabled: true }` only - it never touches `url`/`events`, so a re-enable
 * can never silently change what the endpoint receives.
 */
export interface DisabledBannerProps {
  id: string;
  disabledReason: string | null;
  onReEnabled: () => void;
}

export function DisabledBanner({
  id,
  disabledReason,
  onReEnabled,
}: DisabledBannerProps): React.JSX.Element {
  const t = useT();
  const [isReEnabling, setIsReEnabling] = React.useState(false);
  const [reEnableError, setReEnableError] = React.useState<string | null>(null);
  const body =
    disabledReason === 'consecutive_failures'
      ? t('webhooks.disabledBanner.consecutiveFailures')
      : t('webhooks.disabledBanner.generic');

  const onReEnable = async (): Promise<void> => {
    setReEnableError(null);
    setIsReEnabling(true);
    try {
      await patchWebhookEndpoint(id, { enabled: true });
      onReEnabled();
    } catch (error) {
      setReEnableError(
        error instanceof ApiError ? error.message : t('webhooks.disabledBanner.reEnableError'),
      );
    } finally {
      setIsReEnabling(false);
    }
  };

  return (
    <Alert
      data-testid="webhook-disabled-banner"
      tone="danger"
      title={t('webhooks.disabledBanner.title')}
      body={body}
      action={
        <div className="flex flex-col items-start gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            data-testid="webhook-reenable-button"
            loading={isReEnabling}
            loadingLabel={t('common.loading')}
            onClick={() => void onReEnable()}
          >
            {t('webhooks.disabledBanner.reEnableButton')}
          </Button>
          {reEnableError ? (
            <p
              role="alert"
              data-testid="webhook-reenable-error"
              className="text-sm font-ui text-danger"
            >
              {reEnableError}
            </p>
          ) : null}
        </div>
      }
    />
  );
}

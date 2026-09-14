import { AlertTriangle } from 'lucide-react';
import { Alert, useT } from '@wp/ui';
import { useWalletSummary, useQueueStatus } from '../api.js';

/**
 * WalletBanner (P19 Unit U5, step 7) - renders `wallet.empty.banner`
 * (state === 'empty', with the live `{queued}` count from `GET
 * /v1/queue-status`'s workspace total) or `wallet.low.banner` (state ===
 * 'low'). Renders nothing for `active`/`frozen` (`frozen` is a temporary
 * absorbing state the reconciler clears - it is not a customer-facing
 * "add funds" moment, same reasoning `credit.service.ts`'s own wake-gate
 * doc comment gives for excluding `frozen` from the zero-claim transition).
 * Every string is `t('wallet.*')` (core invariant 6: no delivery-speed or
 * restriction-avoidance promise) - `wallet.empty.banner`/`wallet.low.
 * banner` are pre-written honest copy from P19 U4, never invented here.
 */
export function WalletBanner(): React.JSX.Element | null {
  const t = useT();
  const { data: summary } = useWalletSummary();
  const { data: queueStatus } = useQueueStatus();

  if (!summary || (summary.state !== 'empty' && summary.state !== 'low')) {
    return null;
  }

  const queued = queueStatus?.workspace.waiting ?? 0;
  const message =
    summary.state === 'empty' ? t('wallet.empty.banner', { queued }) : t('wallet.low.banner');

  return (
    <Alert
      data-testid="wallet-banner"
      tone="warning"
      title={message}
      icon={<AlertTriangle aria-hidden="true" size={16} />}
    />
  );
}

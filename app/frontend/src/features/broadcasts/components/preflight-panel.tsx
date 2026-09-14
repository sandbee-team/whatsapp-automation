import {
  Badge,
  Button,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  CardTitle,
  useLocale,
  useT,
} from '@wp/ui';
import type { BroadcastPreflight, BroadcastPreflightOption } from '@wp/contracts';
import { paiseToRupees } from '../../wallet/money.js';

/**
 * PreflightPanel (P23a Unit U3, step 4; P23a C1 fix round NOTE 8) - pure
 * render of a `BroadcastPreflight` quote (no fetching - the caller owns
 * `preflightBroadcast`/`useQuery`). Every string is `t('broadcasts.
 * preflight.*')` or the shared `broadcasts.disclosure`/`broadcasts.
 * frequencyLine`/`broadcasts.estimateCaveat` keys (core invariant 6: no
 * delivery-speed or restriction-avoidance promise) - the options list is
 * rendered ONLY from `quote.estimate.options`, never a hard-coded third
 * "faster" lever (there is no faster mode). Money display uses the shared
 * `paiseToRupees` (`features/wallet/money.ts`), the ONE BIGINT
 * paise-to-display implementation, replacing this file's former local copy.
 */
export interface PreflightPanelProps {
  quote: BroadcastPreflight;
  onStart: () => void;
  onBack: () => void;
  starting: boolean;
  /** A failed Start's already-resolved copy (P23a C1 fix round, C2 addition) - rendered `role="alert"` above the actions so a 503/409 is never silent. */
  errorMessage?: string;
}

const OPTION_KEYS: Record<
  BroadcastPreflightOption,
  'broadcasts.preflight.option.reduce_audience' | 'broadcasts.preflight.option.wait_for_warm_up'
> = {
  reduce_audience: 'broadcasts.preflight.option.reduce_audience',
  wait_for_warm_up: 'broadcasts.preflight.option.wait_for_warm_up',
};

function skipReasonLabel(reason: string, t: ReturnType<typeof useT>): string {
  if (reason === 'opted_out') {
    return t('broadcasts.preflight.skipReason.opted_out');
  }
  const [prefix, token] = reason.split(':');
  if (prefix === 'missing_var' && token) {
    return t('broadcasts.preflight.skipReason.missing_var', { token });
  }
  return reason;
}

export function PreflightPanel({
  quote,
  onStart,
  onBack,
  starting,
  errorMessage,
}: PreflightPanelProps): React.JSX.Element {
  const t = useT();
  const locale = useLocale();
  const dateFormatter = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' });

  return (
    <Card data-testid="preflight-panel">
      <CardHeader>
        <CardTitle>{t('broadcasts.preflight.title')}</CardTitle>
      </CardHeader>
      <CardBody>
        <section>
          <h4>{t('broadcasts.preflight.audience')}</h4>
          <p>{t('broadcasts.preflight.contacts', { count: quote.audience.matched })}</p>
          {quote.audience.skipReasons.map((skip) => (
            <p key={skip.reason} data-testid="preflight-skip-reason">
              {t('broadcasts.preflight.skipped', {
                count: skip.count,
                reason: skipReasonLabel(skip.reason, t),
              })}
            </p>
          ))}
        </section>

        <section>
          <h4>{t('broadcasts.preflight.alreadyMessaged')}</h4>
          <p>
            {t('broadcasts.preflight.alreadyMessagedDetail', {
              count: quote.alreadyMessaged.deferred,
            })}
          </p>
          <p>{t('broadcasts.frequencyLine')}</p>
        </section>

        <section>
          <h4>{t('broadcasts.preflight.billable')}</h4>
          <p>
            {t('broadcasts.preflight.billableDetail', {
              count: quote.billable.count,
              rate: paiseToRupees(quote.billable.rateMinor),
              total: paiseToRupees(quote.billable.quoteMinor),
            })}
          </p>
          <p>{t('broadcasts.preflight.priceNote')}</p>
        </section>

        <section>
          <h4>{t('broadcasts.preflight.wallet')}</h4>
          <p>
            {t('broadcasts.preflight.walletDetail', {
              balance: paiseToRupees(quote.wallet.balanceMinor),
              after: paiseToRupees(quote.wallet.afterMinor),
            })}
          </p>
          {!quote.wallet.sufficient ? (
            <p role="alert" data-testid="preflight-wallet-insufficient">
              {t('broadcasts.preflight.walletInsufficient')}
            </p>
          ) : null}
        </section>

        <section>
          <h4>{t('broadcasts.preflight.account')}</h4>
          <p>
            {t('broadcasts.preflight.accountDetail', {
              label: quote.account.label,
              tier: quote.account.warmupTier,
              cap: quote.account.effDailyCap,
              sent: quote.account.sentToday,
            })}
          </p>
        </section>

        <section data-testid="preflight-estimate">
          <h4>{t('broadcasts.preflight.estimate')}</h4>
          {quote.estimate.totalDays === null ? (
            <p>{t('broadcasts.preflight.estimateUnavailable')}</p>
          ) : quote.estimate.totalDays === 0 ? (
            <p>
              {t('broadcasts.preflight.estimateToday', {
                date:
                  quote.estimate.finishAt !== null
                    ? dateFormatter.format(new Date(quote.estimate.finishAt))
                    : '',
              })}
            </p>
          ) : (
            <p>
              {t('broadcasts.preflight.estimateDays', {
                days: quote.estimate.totalDays,
                date:
                  quote.estimate.finishAt !== null
                    ? dateFormatter.format(new Date(quote.estimate.finishAt))
                    : '',
              })}
            </p>
          )}
          <p>{t('broadcasts.estimateCaveat')}</p>

          {quote.estimate.options.length > 0 ? (
            <>
              <p>{t('broadcasts.preflight.optionsIntro')}</p>
              <ul>
                {quote.estimate.options.map((option) => (
                  <li key={option} data-testid="preflight-option">
                    {t(OPTION_KEYS[option])}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </section>

        {quote.fanOut.requiresHumanAck ? (
          <p data-testid="preflight-fanout-notice">
            <Badge tone="warning">
              {t('broadcasts.preflight.fanOutAck', { threshold: quote.fanOut.ackThreshold })}
            </Badge>
          </p>
        ) : null}

        {quote.groups ? (
          <section data-testid="preflight-groups">
            <h4>{t('groups.title')}</h4>
            <p>
              {t('groups.preflight.reach', {
                count: quote.groups.reachEstimate,
                groups: quote.groups.groupsMatched,
              })}
            </p>
            <p>
              {t('groups.preflight.capLine', {
                remaining: quote.groups.groupRemainingToday,
                cap: quote.groups.effGroupDailyCap,
              })}
            </p>
            {quote.groups.capIsZeroAtTier ? <p>{t('groups.preflight.offAtTier')}</p> : null}
            {quote.groups.groupsSkipped > 0 ? (
              <p>
                {t('groups.preflight.skipped', {
                  count: quote.groups.groupsSkipped,
                  reasons: quote.groups.skipReasons.map((skip) => skip.reason).join(', '),
                })}
              </p>
            ) : null}
            <p data-testid="group-header-disclosure">{t('groups.disclosure')}</p>
          </section>
        ) : null}

        <p data-testid="broadcast-disclosure">{t('broadcasts.disclosure')}</p>

        {errorMessage ? (
          <p role="alert" className="text-sm font-ui text-danger">
            {errorMessage}
          </p>
        ) : null}
      </CardBody>
      <CardFooter>
        <Button
          variant="secondary"
          onClick={onBack}
          disabled={starting}
          loading={starting}
          loadingLabel={t('common.loading')}
        >
          {t('broadcasts.preflight.back')}
        </Button>
        <Button
          variant="primary"
          onClick={onStart}
          disabled={starting}
          loading={starting}
          loadingLabel={t('common.loading')}
        >
          {t('broadcasts.preflight.start')}
        </Button>
      </CardFooter>
    </Card>
  );
}

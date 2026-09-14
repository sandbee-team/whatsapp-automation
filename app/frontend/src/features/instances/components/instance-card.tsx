import * as React from 'react';
import { Badge, Card, CardBody, CardHeader, CardTitle, useT } from '@wp/ui';
import type { InstanceCardResult } from '../api.js';
import { ParkedBanner } from './parked-banner.js';
import { NeedsActionBanner } from './needs-action-banner.js';
import { InstanceCardProgressBar, InstanceCardStatsStrip } from './instance-card-parts.js';

/**
 * InstanceCard (P17 U5; 2026-09-08 panel refresh restyle, unit S4) - the
 * per-instance summary card: header (state dot, pulsing sibling only when
 * connected - colour is never the only signal, the dot is `aria-hidden` and
 * paired with the `Badge` health text below) + label + health `Badge`; body =
 * parked/needs-action banners, pacing-profile/warm-up line (see
 * `instances.card.safeModeStatus` for the exact copy), two labelled progress
 * bars (today / new conversations, `InstanceCardProgressBar` from
 * `instance-card-parts.tsx`), a three-cell stats strip (Queued / Next send·
 * Not sending / Window, `InstanceCardStatsStrip`); footer = health + [why?]
 * and the queue summary line. Every existing `instance-card-*` testid and
 * sentence copy is unchanged - only the surrounding chrome and layout moved.
 *
 * Countdown math: `skew = Date.parse(serverNow) - now()` captured once per
 * render from the CARD DATA's own `serverNow` (never the browser clock
 * alone), then `remaining = nextSendEarliestAt + skew - now()` on every
 * tick. While `parked` or `healthState === 'paused'` (this instance is not
 * sending, whatever the timestamp says) OR `nextSendEarliestAt` is `null`:
 * renders the "not sending" floor string and schedules NO timer at all -
 * `instance-card.test.tsx`'s
 * `the_countdown_stops_and_reads_not_sending_when_paused` asserts zero
 * pending intervals in that state, same "no silent auto-anything" idiom as
 * `QrPanel.tsx`'s expired-state test.
 */
export interface InstanceCardProps {
  data: InstanceCardResult;
  onOpenWhyDrawer: () => void;
  /** Injectable clock, default `() => Date.now()` - test seam, same idiom as `QrPanel`. */
  now?: () => number;
  /** Injectable tick interval (ms), default 1000. */
  tickIntervalMs?: number;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
}

const DEFAULT_TICK_INTERVAL_MS = 1000;

function isNotSending(data: InstanceCardResult): boolean {
  return data.parked || data.healthState === 'paused' || data.nextSendEarliestAt === null;
}

export function InstanceCard({
  data,
  onOpenWhyDrawer,
  now = () => Date.now(),
  tickIntervalMs = DEFAULT_TICK_INTERVAL_MS,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
}: InstanceCardProps): React.JSX.Element {
  const t = useT();
  const [, forceTick] = React.useReducer((n: number) => n + 1, 0);
  const notSending = isNotSending(data);

  // Skew is captured ONCE per `serverNow` value (i.e. once per card fetch),
  // never recomputed on every tick - recomputing it against a moving
  // `now()` on each render would silently cancel out the elapsed time the
  // countdown is supposed to show.
  const skewMs = React.useMemo(() => Date.parse(data.serverNow) - now(), [data.serverNow]);

  React.useEffect(() => {
    // Hard invariant: no timer of any kind is ever scheduled while not
    // sending - never merely "not rendering" the ticking value.
    if (notSending) return undefined;
    const intervalId = setIntervalFn(() => forceTick(), tickIntervalMs);
    return () => clearIntervalFn(intervalId);
  }, [notSending, tickIntervalMs, setIntervalFn, clearIntervalFn]);

  const remainingSeconds =
    !notSending && data.nextSendEarliestAt
      ? Math.max(0, Math.round((Date.parse(data.nextSendEarliestAt) + skewMs - now()) / 1000))
      : 0;

  const queueCountLabel = data.queueDepthCapped
    ? t('instances.card.queueDepthCapped')
    : String(data.queueDepth);

  const isConnected = data.healthState === 'connected';
  const nextSendCellValue = notSending ? (
    <span data-testid="instance-card-not-sending" className="text-muted">
      {t('instances.card.notSending')}
    </span>
  ) : (
    <span data-testid="instance-card-next-send">
      {t('instances.card.nextSendEarliest', { seconds: remainingSeconds })}
    </span>
  );

  return (
    <Card data-testid="instance-card">
      <CardHeader>
        <div className="flex items-center gap-2">
          <span className="relative inline-flex h-2 w-2">
            {isConnected ? (
              <span
                aria-hidden="true"
                className="absolute inline-flex h-full w-full animate-pulse-ring rounded-full bg-success motion-reduce:animate-none"
              />
            ) : null}
            <span
              data-testid="instance-card-state-dot"
              aria-hidden="true"
              className={
                isConnected
                  ? 'relative h-2 w-2 rounded-full bg-success animate-pulse motion-reduce:animate-none'
                  : 'relative h-2 w-2 rounded-full bg-danger'
              }
            />
          </span>
          <CardTitle>{data.label}</CardTitle>
        </div>
        <Badge tone={data.healthScore !== null && data.healthScore >= 70 ? 'success' : 'warning'}>
          {t('instances.card.health', {
            score: data.healthScore ?? 0,
            band: data.healthBand,
          })}
        </Badge>
      </CardHeader>
      <CardBody className="flex flex-col gap-3">
        {data.parked ? <ParkedBanner /> : null}

        {data.needsUserAction && data.userActionReason ? (
          <NeedsActionBanner reason={data.userActionReason} instanceId={data.instanceId} />
        ) : null}

        <div>
          <p data-testid="instance-card-safe-mode-status" className="text-sm font-ui text-fg">
            {t('instances.card.safeModeStatus', {
              profile: t('instances.card.pacingProfileName'),
              tier: data.warmupTier,
              day: data.warmupDay,
            })}
          </p>
          <p className="text-xs font-ui text-muted">{t('instances.card.safeModeDisclaimer')}</p>
        </div>

        <div className="flex flex-col gap-3">
          <InstanceCardProgressBar
            label={
              <span data-testid="instance-card-today-progress">
                {t('instances.card.todayProgress', {
                  sent: data.todaySent,
                  cap: data.effDailyCap,
                })}
              </span>
            }
            value={data.todaySent}
            max={data.effDailyCap}
            tone="accent"
            ariaLabel={t('instances.card.todayProgress', {
              sent: data.todaySent,
              cap: data.effDailyCap,
            })}
          />
          <InstanceCardProgressBar
            label={
              <span data-testid="instance-card-new-conversations">
                {t('instances.card.newConversations', {
                  count: data.newConversationsToday,
                  cap: data.effNewConvCap,
                })}
              </span>
            }
            value={data.newConversationsToday}
            max={data.effNewConvCap}
            tone="info"
            ariaLabel={t('instances.card.newConversations', {
              count: data.newConversationsToday,
              cap: data.effNewConvCap,
            })}
          />
        </div>

        <InstanceCardStatsStrip
          queuedLabel={t('instances.card.stats.queued')}
          queuedValue={queueCountLabel}
          nextSendLabel={t('instances.card.stats.nextSend')}
          nextSendValue={nextSendCellValue}
          windowLabel={t('instances.card.stats.window')}
          windowValue={t('instances.card.sendingWindow', {
            start: data.sendingWindow.start,
            end: data.sendingWindow.end,
            tz: data.sendingWindow.tz,
          })}
        />

        <div className="flex items-center justify-between gap-2 border-t border-border pt-3">
          <p data-testid="instance-card-queue-summary" className="text-xs font-ui text-muted">
            {t('instances.card.queueSummary', {
              count: queueCountLabel,
              age: data.oldestQueuedAgeSeconds ?? 0,
              lastSend: data.lastSendAt ?? '—',
            })}
          </p>
          <button
            type="button"
            data-testid="instance-card-why-link"
            className="shrink-0 text-sm font-ui text-accent underline"
            onClick={(event) => {
              event.stopPropagation();
              onOpenWhyDrawer();
            }}
          >
            {t('instances.card.healthWhyLink')}
          </button>
        </div>
      </CardBody>
    </Card>
  );
}

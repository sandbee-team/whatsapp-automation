import * as React from 'react';
import QRCode from 'qrcode';
import { Badge, Button, useT } from '@wp/ui';

/**
 * QrPanel (P08 U7) - renders the live QR challenge: the payload string as a
 * scannable `<img>` (via `qrcode`'s `toDataURL`), a 45s countdown ring (SVG
 * circle, driven by `expiresAt` vs an injected `now()` so tests can drive it
 * with fake timers deterministically - never a bare `Date.now()`), and the
 * attempts-left `Badge`. On expiry: NO auto-retry timer, ever - only a
 * "Generate a new code" button the user must click, wired to `onRefresh`
 * (`refreshLink`). This is a hard safety/UX invariant (core canon: no silent
 * automatic re-issuance of a bearer credential) and is asserted directly by
 * `connect_expired_state_shows_button_never_auto_retries`.
 */
export interface QrPanelProps {
  payload: string | null;
  expiresAt: string | null;
  attemptsLeft: number | null;
  onRefresh: () => void;
  isRefreshing?: boolean;
  /** Injectable clock, default `() => Date.now()` - test seam, never called directly with `Date.now()` inline. */
  now?: () => number;
  /** Injectable tick interval (ms) driving the countdown re-render, default 1000. */
  tickIntervalMs?: number;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
}

const RING_RADIUS = 20;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
const DEFAULT_TICK_INTERVAL_MS = 1000;

function useQrDataUrl(payload: string | null): string | null {
  const [dataUrl, setDataUrl] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!payload) {
      setDataUrl(null);
      return;
    }
    let cancelled = false;
    void QRCode.toDataURL(payload).then((url) => {
      if (!cancelled) setDataUrl(url);
    });
    return () => {
      cancelled = true;
    };
  }, [payload]);

  return dataUrl;
}

export function QrPanel({
  payload,
  expiresAt,
  attemptsLeft,
  onRefresh,
  isRefreshing = false,
  now = () => Date.now(),
  tickIntervalMs = DEFAULT_TICK_INTERVAL_MS,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
}: QrPanelProps): React.JSX.Element {
  const t = useT();
  const dataUrl = useQrDataUrl(payload);
  const [, forceTick] = React.useReducer((n: number) => n + 1, 0);

  React.useEffect(() => {
    if (!expiresAt) return undefined;
    const intervalId = setIntervalFn(() => forceTick(), tickIntervalMs);
    return () => clearIntervalFn(intervalId);
  }, [expiresAt, tickIntervalMs, setIntervalFn, clearIntervalFn]);

  const expiresAtMs = expiresAt ? new Date(expiresAt).getTime() : null;
  const remainingMs = expiresAtMs !== null ? Math.max(0, expiresAtMs - now()) : 0;
  const isExpired = expiresAtMs !== null && remainingMs <= 0;
  const totalWindowMs = 45_000;
  const fraction = Math.min(1, Math.max(0, remainingMs / totalWindowMs));
  const dashOffset = RING_CIRCUMFERENCE * (1 - fraction);
  const remainingSeconds = Math.ceil(remainingMs / 1000);

  return (
    <div data-testid="qr-panel" className="flex flex-col items-center gap-4">
      <h3 className="text-base font-semibold font-ui text-fg">{t('instances.connect.qr.title')}</h3>
      <p className="text-sm font-ui text-muted">{t('instances.connect.qr.body')}</p>

      {isExpired ? (
        <div data-testid="qr-expired" className="flex flex-col items-center gap-3">
          <p className="text-sm font-ui text-danger">{t('instances.connect.qr.expired')}</p>
          <Button
            type="button"
            data-testid="qr-refresh-button"
            onClick={onRefresh}
            loading={isRefreshing}
            loadingLabel={t('common.loading')}
          >
            {t('instances.connect.qr.refreshButton')}
          </Button>
        </div>
      ) : (
        <div className="relative flex items-center justify-center" data-testid="qr-countdown-ring">
          <svg width="180" height="180" viewBox="0 0 48 48" aria-hidden="true">
            <circle
              cx="24"
              cy="24"
              r={RING_RADIUS}
              fill="none"
              stroke="currentColor"
              className="text-border"
              strokeWidth="3"
            />
            <circle
              cx="24"
              cy="24"
              r={RING_RADIUS}
              fill="none"
              stroke="currentColor"
              className="text-accent"
              strokeWidth="3"
              strokeDasharray={RING_CIRCUMFERENCE}
              strokeDashoffset={dashOffset}
              strokeLinecap="round"
              transform="rotate(-90 24 24)"
            />
          </svg>
          {dataUrl ? (
            <img
              src={dataUrl}
              alt={t('instances.connect.qr.title')}
              data-testid="qr-image"
              className="absolute h-32 w-32"
            />
          ) : null}
          <span data-testid="qr-seconds-left" className="sr-only">
            {remainingSeconds}
          </span>
        </div>
      )}

      {attemptsLeft !== null ? (
        <Badge tone={attemptsLeft > 0 ? 'info' : 'warning'} data-testid="qr-attempts-left">
          {t('instances.connect.qr.attemptsLeft', { count: attemptsLeft })}
        </Badge>
      ) : null}
    </div>
  );
}

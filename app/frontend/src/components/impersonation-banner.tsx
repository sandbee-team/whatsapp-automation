'use client';

import * as React from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Eye } from 'lucide-react';
import { Button, useT } from '@wp/ui';
import { clearImpersonatedSession, setAccessToken } from '../lib/api-client.js';

/**
 * ImpersonationBanner (P28 Unit U7, design brief section 3) - a persistent,
 * sticky, full-width warning banner rendered by `_authed`'s layout ABOVE the
 * top bar whenever `me.impersonation` is present (staff support session).
 * Colour is never the only signal (core invariant / a11y rule): the
 * `Eye` icon + "Support session" text carry the meaning, the warning tone
 * classes are a reinforcement only. The countdown accepts an injectable
 * `now` so tests never depend on real wall-clock timing (test-discipline).
 */
export interface ImpersonationInfo {
  grantId: string;
  scope: 'metadata_only' | 'with_message_bodies';
  expiresAt: string;
  staffLabel: string;
}

export interface ImpersonationBannerProps {
  impersonation: ImpersonationInfo;
  /** Injectable clock for deterministic countdown tests. Defaults to `Date.now`. */
  now?: () => number;
}

function formatCountdown(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(remainingMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function ImpersonationBanner({
  impersonation,
  now = Date.now,
}: ImpersonationBannerProps): React.JSX.Element {
  const t = useT();
  const navigate = useNavigate();
  const expiresAtMs = React.useMemo(
    () => new Date(impersonation.expiresAt).getTime(),
    [impersonation.expiresAt],
  );
  const [remainingMs, setRemainingMs] = React.useState(() => expiresAtMs - now());

  // `now` is deliberately NOT a dependency: it is an injectable clock, not
  // reactive state, and a test passing an inline arrow would otherwise tear
  // down and reinstall the interval on every render.
  React.useEffect(() => {
    setRemainingMs(expiresAtMs - now());
    const interval = setInterval(() => {
      setRemainingMs(expiresAtMs - now());
    }, 1000);
    return () => clearInterval(interval);
  }, [expiresAtMs]);

  const scopeLabel =
    impersonation.scope === 'with_message_bodies'
      ? t('impersonation.banner.scopeWithBodies')
      : t('impersonation.banner.scopeMetadataOnly');

  const ended = remainingMs <= 0;

  const onEndSession = (): void => {
    setAccessToken(null);
    clearImpersonatedSession();
    void navigate({ to: '/login' });
  };

  return (
    <div
      role="status"
      data-testid="impersonation-banner"
      className="sticky top-0 z-50 flex h-10 w-full items-center justify-between gap-3 border-b border-warning bg-warning-soft px-4 font-ui text-sm text-warning"
    >
      <span className="flex min-w-0 items-center gap-2">
        <Eye aria-hidden size={16} className="shrink-0" />
        <span className="truncate">
          {ended
            ? t('impersonation.banner.ended')
            : t('impersonation.banner.active', {
                staffLabel: impersonation.staffLabel,
                scope: scopeLabel,
                countdown: formatCountdown(remainingMs),
              })}
        </span>
      </span>
      <Button
        type="button"
        variant="outline"
        size="sm"
        data-testid="impersonation-banner-end-session"
        onClick={onEndSession}
      >
        {t('impersonation.banner.endSessionButton')}
      </Button>
    </div>
  );
}

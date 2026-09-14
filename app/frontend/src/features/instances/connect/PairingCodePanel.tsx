import * as React from 'react';
import { Badge, Button, useT } from '@wp/ui';

/**
 * PairingCodePanel (P08 U7) - the 8-character pairing-code challenge:
 * displays the code in `XXXX-XXXX` groups, an attempts-left `Badge`, and on
 * expiry the same "Generate a new code" BUTTON pattern as `QrPanel` - never
 * an auto-retry timer.
 */
export interface PairingCodePanelProps {
  payload: string | null;
  expiresAt: string | null;
  attemptsLeft: number | null;
  onRefresh: () => void;
  isRefreshing?: boolean;
  now?: () => number;
}

function formatCode(payload: string): string {
  const clean = payload.replace(/[^a-zA-Z0-9]/gu, '').toUpperCase();
  const first = clean.slice(0, 4);
  const second = clean.slice(4, 8);
  return second ? `${first}-${second}` : first;
}

export function PairingCodePanel({
  payload,
  expiresAt,
  attemptsLeft,
  onRefresh,
  isRefreshing = false,
  now = () => Date.now(),
}: PairingCodePanelProps): React.JSX.Element {
  const t = useT();
  const expiresAtMs = expiresAt ? new Date(expiresAt).getTime() : null;
  const isExpired = expiresAtMs !== null && expiresAtMs - now() <= 0;

  return (
    <div data-testid="pairing-code-panel" className="flex flex-col items-center gap-4">
      <h3 className="text-base font-semibold font-ui text-fg">
        {t('instances.connect.code.title')}
      </h3>
      <p className="text-sm font-ui text-muted">{t('instances.connect.code.body')}</p>

      {isExpired ? (
        <div data-testid="code-expired" className="flex flex-col items-center gap-3">
          <p className="text-sm font-ui text-danger">{t('instances.connect.code.expired')}</p>
          <Button
            type="button"
            data-testid="code-refresh-button"
            onClick={onRefresh}
            loading={isRefreshing}
            loadingLabel={t('common.loading')}
          >
            {t('instances.connect.code.refreshButton')}
          </Button>
        </div>
      ) : payload ? (
        <p
          data-testid="pairing-code-value"
          className="rounded-md bg-surface px-4 py-2 font-mono text-2xl font-semibold tracking-widest text-fg"
        >
          {formatCode(payload)}
        </p>
      ) : null}

      {attemptsLeft !== null ? (
        <Badge tone={attemptsLeft > 0 ? 'info' : 'warning'} data-testid="code-attempts-left">
          {t('instances.connect.code.attemptsLeft', { count: attemptsLeft })}
        </Badge>
      ) : null}
    </div>
  );
}

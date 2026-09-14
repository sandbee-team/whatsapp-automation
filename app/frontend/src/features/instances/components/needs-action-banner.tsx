import * as React from 'react';
import { Badge, Button, useT } from '@wp/ui';
import type { UserActionReason } from '@wp/domain';

/**
 * NeedsActionBanner (P17 U5) - shown on an `InstanceCard` when
 * `needsUserAction` is true, mapping `userActionReason` (`UserActionReason`,
 * `@wp/domain`) to ONE of three human actions only - open the number's
 * detail section, reconnect, or acknowledge. NEVER an auto-resume
 * affordance or any wording implying sending will resume by itself (core
 * invariant 2: fail-safe, no blind retry - the human decides).
 *
 * `PAIRING_EXPIRED` / `SESSION_REPLACED` / `RELINK_REQUIRED` all route to
 * "open number details" (the relink flow lives there, P08's `ConnectSheet`);
 * `RECONNECT_FAILED` / `INFRA_UNAVAILABLE` offer "Reconnect"; `RESTRICTION_
 * SIGNAL` offers only "Acknowledge" (the pacing copy already tells the
 * tenant to check WhatsApp on the phone themselves - `PACING_COPY.
 * instancePausedRestriction`) - this component renders no restriction-
 * avoidance/ban-outcome text of its own, only the action affordance.
 */
export interface NeedsActionBannerProps {
  reason: string;
  instanceId: string;
  onOpenDetails?: (instanceId: string) => void;
  onReconnect?: (instanceId: string) => void;
  onAcknowledge?: (instanceId: string) => void;
}

const OPEN_DETAILS_REASONS: readonly UserActionReason[] = [
  'PAIRING_EXPIRED',
  'SESSION_REPLACED',
  'RELINK_REQUIRED',
];
const RECONNECT_REASONS: readonly UserActionReason[] = ['RECONNECT_FAILED', 'INFRA_UNAVAILABLE'];

export function NeedsActionBanner({
  reason,
  instanceId,
  onOpenDetails,
  onReconnect,
  onAcknowledge,
}: NeedsActionBannerProps): React.JSX.Element {
  const t = useT();
  const showOpenDetails =
    (OPEN_DETAILS_REASONS as readonly string[]).includes(reason) && Boolean(onOpenDetails);
  const showReconnect =
    (RECONNECT_REASONS as readonly string[]).includes(reason) && Boolean(onReconnect);
  // No acknowledge API/mutation exists anywhere in the app today - render the
  // button only when a caller actually supplies a handler, never a no-op.
  const showAcknowledge = reason === 'RESTRICTION_SIGNAL' && Boolean(onAcknowledge);

  return (
    <div
      role="alert"
      data-testid="needs-action-banner"
      className="flex flex-col gap-2 rounded-md border border-danger bg-surface p-3"
    >
      <Badge tone="danger">{t('instances.needsAction.title')}</Badge>
      <div className="flex items-center gap-2">
        {showOpenDetails ? (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            data-testid="needs-action-open-details"
            onClick={() => onOpenDetails?.(instanceId)}
          >
            {t('instances.needsAction.openPanelSection')}
          </Button>
        ) : null}
        {showReconnect ? (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            data-testid="needs-action-reconnect"
            onClick={() => onReconnect?.(instanceId)}
          >
            {t('instances.needsAction.reconnect')}
          </Button>
        ) : null}
        {showAcknowledge ? (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            data-testid="needs-action-acknowledge"
            onClick={() => onAcknowledge?.(instanceId)}
          >
            {t('instances.needsAction.acknowledge')}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

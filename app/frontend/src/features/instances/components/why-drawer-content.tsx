import * as React from 'react';
import { useT } from '@wp/ui';
import type { HealthWhyResult } from '../api.js';

/**
 * WhyDrawerContent (P26b U3) - the signal list + timeline body, split out of
 * `WhyDrawer.tsx` so the instance detail page's Health tab can render the
 * SAME content inline (no Sheet chrome) without duplicating the honest-
 * label logic. Every `why-drawer-*` test id stays on this shared body.
 */
export interface WhyDrawerContentProps {
  data: HealthWhyResult | undefined;
}

/**
 * `exemptReason` is a free-form server string (no closed enum in the
 * contract) - `pointsCost === 0` is the honest, contract-guaranteed signal
 * that a `scored: false` row is "observed but not weighted".
 */
function honestLabelFor(pointsCost: number, t: ReturnType<typeof useT>): string {
  return pointsCost === 0
    ? t('instances.whyDrawer.signalNotScored')
    : t('instances.whyDrawer.signalNotEnoughData');
}

export function WhyDrawerContent({ data }: WhyDrawerContentProps): React.JSX.Element {
  const t = useT();

  return (
    <div data-testid="why-drawer-content" className="flex flex-col gap-3">
      <ul data-testid="why-drawer-signals" className="flex flex-col gap-2">
        {(data?.signals ?? []).map((signal) => {
          const honestLabel = signal.scored ? null : honestLabelFor(signal.pointsCost, t);
          return (
            <li
              key={signal.signal}
              data-testid={`why-drawer-signal-${signal.signal}`}
              className="flex flex-col gap-1 rounded-md border border-border p-2"
            >
              <span className="text-sm font-medium font-ui text-fg">{signal.signal}</span>
              {signal.scored ? (
                <span className="text-xs font-ui text-muted">
                  {signal.measuredValue !== null ? `${String(signal.measuredValue)} · ` : ''}
                  {t('instances.whyDrawer.window', { window: signal.window })}
                  {' · '}
                  {t('instances.whyDrawer.evidenceCount', { count: signal.evidenceCount })}
                  {' · '}
                  {t('instances.whyDrawer.pointsCost', { points: signal.pointsCost })}
                </span>
              ) : (
                <span
                  data-testid={`why-drawer-signal-honest-${signal.signal}`}
                  className="text-xs font-ui text-muted"
                >
                  {honestLabel}
                </span>
              )}
            </li>
          );
        })}
      </ul>

      <h3 className="text-sm font-semibold font-ui text-fg">
        {t('instances.whyDrawer.timelineTitle')}
      </h3>
      <ul data-testid="why-drawer-timeline" className="flex flex-col gap-1">
        {(data?.timeline ?? []).map((entry) => (
          <li key={entry.id} className="text-xs font-ui text-muted">
            {entry.kind} · {entry.createdAt}
          </li>
        ))}
      </ul>
    </div>
  );
}

import * as React from 'react';
import { TONE_BG, clampPercent } from '@wp/ui';
import type { ChartTone } from '@wp/ui';

/**
 * instance-card-parts.tsx (2026-09-08 panel refresh, unit S4) - presentational
 * pieces split out of `instance-card.tsx` to stay under the 300-line cap: a
 * single labelled progress bar (today/new-conversations, spec section 7 -
 * "built with BarList or a local bar"; a local bar is used here because each
 * bar's accessible label is a full existing sentence key
 * (`instances.card.todayProgress` / `newConversations`) that must render
 * byte-identical to today, not a `BarList` row shape) and the three-cell
 * stats strip (Queued / Next send·Not sending / Window). No countdown/timer
 * logic lives here - `instance-card.tsx` computes every value and passes it
 * down as plain props.
 */
export interface InstanceCardProgressBarProps {
  /** Rendered above the bar verbatim - callers pass the existing sentence copy. */
  label: React.ReactNode;
  value: number;
  max: number;
  tone?: ChartTone;
  /** Accessible name for the `progressbar` role - a short noun phrase, not the full sentence. */
  ariaLabel: string;
}

export function InstanceCardProgressBar({
  label,
  value,
  max,
  tone = 'accent',
  ariaLabel,
}: InstanceCardProgressBarProps): React.JSX.Element {
  const safeMax = Math.max(1, max);
  const percent = clampPercent((value / safeMax) * 100);

  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-sm font-ui text-fg">{label}</p>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
        <div
          role="progressbar"
          aria-label={ariaLabel}
          aria-valuenow={value}
          aria-valuemin={0}
          aria-valuemax={max}
          className={`h-full rounded-full transition-[width] duration-700 ease-out motion-reduce:transition-none ${TONE_BG[tone]}`}
          style={{ width: `${String(percent)}%` }}
        />
      </div>
    </div>
  );
}

export interface InstanceCardStatCellProps {
  label: string;
  children: React.ReactNode;
  testId?: string;
}

function InstanceCardStatCell({
  label,
  children,
  testId,
}: InstanceCardStatCellProps): React.JSX.Element {
  return (
    <div className="flex flex-col gap-0.5" data-testid={testId}>
      <span className="text-[11px] font-medium uppercase tracking-wider text-muted">{label}</span>
      <span className="text-sm font-ui text-fg">{children}</span>
    </div>
  );
}

export interface InstanceCardStatsStripProps {
  queuedLabel: string;
  queuedValue: React.ReactNode;
  nextSendLabel: string;
  nextSendValue: React.ReactNode;
  windowLabel: string;
  windowValue: React.ReactNode;
}

export function InstanceCardStatsStrip({
  queuedLabel,
  queuedValue,
  nextSendLabel,
  nextSendValue,
  windowLabel,
  windowValue,
}: InstanceCardStatsStripProps): React.JSX.Element {
  return (
    <div
      data-testid="instance-card-stats-strip"
      className="grid grid-cols-3 gap-3 rounded-lg bg-surface-2 p-3"
    >
      <InstanceCardStatCell label={queuedLabel}>{queuedValue}</InstanceCardStatCell>
      <InstanceCardStatCell label={nextSendLabel}>{nextSendValue}</InstanceCardStatCell>
      <InstanceCardStatCell label={windowLabel}>{windowValue}</InstanceCardStatCell>
    </div>
  );
}

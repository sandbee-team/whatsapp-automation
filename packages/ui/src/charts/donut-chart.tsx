'use client';

import * as React from 'react';
import { cx } from '../lib/cx.js';
import { arcPath, clampPercent, TONE_STROKE, TONE_BG, type ChartTone } from './chart-support.js';

/**
 * DonutChart - a stacked-segment ring (e.g. "Today's outcomes": sent/failed/
 * waiting) with a always-visible text legend (value + percentage per
 * segment - colour is never the only signal). When every segment value is
 * 0, only the track is drawn and the caller shows an honest empty message
 * via `centre`. `'use client'`: segments animate their arc length in on
 * mount (same draw-in treatment as ProgressRing).
 */
export type DonutChartSize = 'sm' | 'md' | 'lg';

const SIZE_PX: Record<DonutChartSize, number> = { sm: 96, md: 144, lg: 192 };
const GAP_DEGREES = 2;

export interface DonutSegment {
  id: string;
  label: string;
  value: number;
  tone: ChartTone;
}

export interface DonutChartProps {
  segments: DonutSegment[];
  /** Denominator for percentages; defaults to the sum of segment values. */
  total?: number;
  /** Accessible label for the chart as a whole, e.g. "Today's outcomes". */
  label: string;
  centre?: React.ReactNode;
  size?: DonutChartSize;
  /** Renders the text legend below the ring. Default true. */
  legend?: boolean;
  className?: string;
}

interface PlacedSegment extends DonutSegment {
  startAngle: number;
  endAngle: number;
  percent: number;
}

function placeSegments(segments: DonutSegment[], total: number): PlacedSegment[] {
  if (total <= 0) return [];
  const gapCount = segments.filter((segment) => segment.value > 0).length;
  const gapTotal = gapCount > 1 ? gapCount * GAP_DEGREES : 0;
  const availableDegrees = 360 - gapTotal;

  let cursor = 0;
  const placed: PlacedSegment[] = [];
  for (const segment of segments) {
    const percent = (segment.value / total) * 100;
    const span = (segment.value / total) * availableDegrees;
    if (segment.value > 0) {
      placed.push({ ...segment, startAngle: cursor, endAngle: cursor + span, percent });
      cursor += span + GAP_DEGREES;
    } else {
      placed.push({ ...segment, startAngle: cursor, endAngle: cursor, percent });
    }
  }
  return placed;
}

export function DonutChart({
  segments,
  total,
  label,
  centre,
  size = 'md',
  legend = true,
  className,
}: DonutChartProps): React.JSX.Element {
  const dimension = SIZE_PX[size];
  const thickness = size === 'sm' ? 10 : size === 'lg' ? 18 : 14;
  const radius = dimension / 2 - thickness / 2;
  const center = dimension / 2;
  const sum = segments.reduce((acc, segment) => acc + Math.max(0, segment.value), 0);
  const denominator = total ?? sum;
  const hasValue = denominator > 0 && sum > 0;

  const placed = React.useMemo(
    () => (hasValue ? placeSegments(segments, denominator) : []),
    [segments, denominator, hasValue],
  );

  const [drawn, setDrawn] = React.useState(false);
  React.useEffect(() => {
    setDrawn(true);
  }, [placed]);

  return (
    <div className={cx('flex flex-col items-center gap-4', className)}>
      <span
        role="img"
        aria-label={label}
        className="relative inline-flex shrink-0 items-center justify-center"
        style={{ width: dimension, height: dimension }}
      >
        <svg
          width={dimension}
          height={dimension}
          viewBox={`0 0 ${dimension} ${dimension}`}
          aria-hidden="true"
        >
          <circle
            data-testid="donut-chart-track"
            cx={center}
            cy={center}
            r={radius}
            fill="none"
            strokeWidth={thickness}
            className="stroke-surface-2"
          />
          {placed
            .filter((segment) => segment.endAngle > segment.startAngle)
            .map((segment) => (
              <path
                key={segment.id}
                data-testid="donut-chart-segment"
                d={arcPath(
                  center,
                  center,
                  radius,
                  segment.startAngle,
                  drawn ? segment.endAngle : segment.startAngle,
                )}
                fill="none"
                strokeWidth={thickness}
                strokeLinecap="round"
                className={cx(
                  TONE_STROKE[segment.tone],
                  'transition-[d] duration-700 ease-out motion-reduce:transition-none',
                )}
              />
            ))}
        </svg>
        {centre ? (
          <span className="absolute inset-0 flex items-center justify-center text-center">
            {centre}
          </span>
        ) : null}
      </span>
      {legend ? (
        <ul role="list" className="flex w-full flex-col gap-2">
          {segments.map((segment) => {
            const percent = hasValue
              ? clampPercent((Math.max(0, segment.value) / denominator) * 100)
              : 0;
            return (
              <li key={segment.id} className="flex items-center justify-between gap-2 text-sm">
                <span className="inline-flex items-center gap-2 text-fg">
                  <span
                    aria-hidden="true"
                    className={cx('h-2 w-2 shrink-0 rounded-full', TONE_BG[segment.tone])}
                  />
                  {segment.label}
                </span>
                <span className="tabular-nums text-muted">
                  {segment.value} &middot; {Math.round(percent)}%
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

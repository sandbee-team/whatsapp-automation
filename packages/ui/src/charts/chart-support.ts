/**
 * chart-support.ts - shared geometry and tone helpers for the hand-written
 * SVG charts (ProgressRing, DonutChart, BarList). No raw colour literals: the
 * tone maps below resolve ONLY to Tailwind `stroke-*`/`fill-*`/`bg-*` token
 * classes (design doc: charts colour via token classes or `currentColor`
 * only). Pure functions, no React, no `'use client'`.
 */
export type ChartTone = 'accent' | 'success' | 'info' | 'warning' | 'danger' | 'muted';

/** Tailwind `stroke-*` class per tone, for SVG circle/path strokes. */
export const TONE_STROKE: Record<ChartTone, string> = {
  accent: 'stroke-accent',
  success: 'stroke-success',
  info: 'stroke-info',
  warning: 'stroke-warning',
  danger: 'stroke-danger',
  muted: 'stroke-muted',
};

/** Tailwind `fill-*` class per tone, for SVG path/shape fills. */
export const TONE_FILL: Record<ChartTone, string> = {
  accent: 'fill-accent',
  success: 'fill-success',
  info: 'fill-info',
  warning: 'fill-warning',
  danger: 'fill-danger',
  muted: 'fill-muted',
};

/** Tailwind `bg-*` class per tone, for HTML bar fills (BarList). */
export const TONE_BG: Record<ChartTone, string> = {
  accent: 'bg-accent',
  success: 'bg-success',
  info: 'bg-info',
  warning: 'bg-warning',
  danger: 'bg-danger',
  muted: 'bg-muted',
};

/**
 * Clamps `value` into `[0, max]` (default max 100). Non-finite input (NaN,
 * +/-Infinity) is treated as 0 so a bad derivation never renders a broken
 * arc/bar instead of failing loudly upstream.
 */
export function clampPercent(value: number, max = 100): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > max) return max;
  return value;
}

interface Point {
  x: number;
  y: number;
}

/** Point on a circle of `radius` centred at (`cx`,`cy`) for `angleDeg`
 * measured clockwise from the top (12 o'clock = 0deg). */
function pointOnCircle(cx: number, cy: number, radius: number, angleDeg: number): Point {
  const angleRad = ((angleDeg - 90) * Math.PI) / 180;
  return { x: cx + radius * Math.cos(angleRad), y: cy + radius * Math.sin(angleRad) };
}

/**
 * Builds an SVG path `d` string for a ring segment (an arc, not a pie slice):
 * a stroked arc from `startAngle` to `endAngle` degrees (clockwise from the
 * top) at `radius` around (`cx`,`cy`). Used by DonutChart to draw stacked
 * segments with a visible gap between them. Angles are clamped to
 * `[0, 360]`; a zero-length arc (`startAngle === endAngle`) returns an empty
 * string so callers can skip rendering it.
 */
export function arcPath(
  cx: number,
  cy: number,
  radius: number,
  startAngle: number,
  endAngle: number,
): string {
  const start = clampPercent(startAngle, 360);
  const end = clampPercent(endAngle, 360);
  if (end <= start) return '';

  const startPoint = pointOnCircle(cx, cy, radius, start);
  const endPoint = pointOnCircle(cx, cy, radius, end);
  const largeArcFlag = end - start > 180 ? 1 : 0;

  return `M ${startPoint.x} ${startPoint.y} A ${radius} ${radius} 0 ${largeArcFlag} 1 ${endPoint.x} ${endPoint.y}`;
}

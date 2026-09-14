'use client';

import * as React from 'react';
import { cx } from './lib/cx.js';

/**
 * Motion primitives (panel-refresh spec section 3, unit F1): `Reveal` runs a
 * one-time enter animation on mount (`rise`/`pop`/`fade`), `Stagger` wraps
 * each direct child in a `Reveal` with an incrementing delay, and
 * `useCountUp`/`AnimatedNumber` count a number up to its target once on
 * mount. Every animation has a `motion-reduce:animate-none` fallback and
 * `useCountUp` itself respects `prefers-reduced-motion` (jumps straight to
 * the target) plus any environment without `requestAnimationFrame` (tests -
 * jsdom does not implement it). Carries `'use client'`: uses `useState`/
 * `useEffect`/`useRef`.
 */
export type RevealAs = 'div' | 'section' | 'li' | 'span';
export type RevealVariant = 'rise' | 'pop' | 'fade';

const VARIANT_ANIMATE_CLASS: Record<RevealVariant, string> = {
  rise: 'animate-rise-in',
  pop: 'animate-pop-in',
  fade: 'animate-fade-in',
};

export interface RevealProps extends React.HTMLAttributes<HTMLElement> {
  as?: RevealAs;
  variant?: RevealVariant;
  /** Enter-animation delay in ms, applied as inline `animationDelay`. */
  delayMs?: number;
  children?: React.ReactNode;
}

export function Reveal({
  as = 'div',
  variant = 'rise',
  delayMs = 0,
  className,
  style,
  children,
  ...rest
}: RevealProps): React.JSX.Element {
  const Tag = as as React.ElementType;
  return (
    <Tag
      className={cx(VARIANT_ANIMATE_CLASS[variant], 'motion-reduce:animate-none', className)}
      style={{ ...style, animationDelay: `${String(delayMs)}ms` }}
      {...rest}
    >
      {children}
    </Tag>
  );
}

export type StaggerAs = 'div' | 'ul' | 'ol' | 'section';

export interface StaggerProps extends React.HTMLAttributes<HTMLElement> {
  /** Container element. Default 'div'. `ul`/`ol` wrap each child in an `li`. */
  as?: StaggerAs;
  /** Delay increment per child, in ms. Default 60. */
  stepMs?: number;
  /** Delay before the first child, in ms. Default 0. */
  startMs?: number;
  variant?: RevealVariant;
  className?: string;
  children?: React.ReactNode;
}

/**
 * Renders ONE container element (carrying `className` and any other HTML
 * attributes, e.g. `data-testid`) and wraps each direct child in a `Reveal`
 * with an incrementing `startMs + index*stepMs` delay - the container is
 * what participates in the caller's layout (grid/flex), never each wrapper.
 */
export function Stagger({
  as = 'div',
  stepMs = 60,
  startMs = 0,
  variant = 'rise',
  className,
  children,
  ...rest
}: StaggerProps): React.JSX.Element {
  const Container = as as React.ElementType;
  const wrapperAs: RevealAs = as === 'ul' || as === 'ol' ? 'li' : 'div';
  return (
    <Container className={className} {...rest}>
      {React.Children.map(children, (child, index) => (
        <Reveal key={index} as={wrapperAs} variant={variant} delayMs={startMs + index * stepMs}>
          {child}
        </Reveal>
      ))}
    </Container>
  );
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export interface UseCountUpOptions {
  durationMs?: number;
}

/** Counts an integer up from 0 to `target` over `durationMs`, once on mount. */
export function useCountUp(target: number, { durationMs = 700 }: UseCountUpOptions = {}): number {
  const [displayed, setDisplayed] = React.useState<number>(() =>
    prefersReducedMotion() || typeof requestAnimationFrame === 'undefined' ? target : 0,
  );

  React.useEffect(() => {
    if (prefersReducedMotion() || typeof requestAnimationFrame === 'undefined') {
      setDisplayed(target);
      return;
    }

    let frame: number;
    const startTime = performance.now();
    const tick = (now: number): void => {
      const elapsed = now - startTime;
      const progress = Math.min(1, elapsed / durationMs);
      setDisplayed(Math.round(progress * target));
      if (progress < 1) {
        frame = requestAnimationFrame(tick);
      }
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target, durationMs]);

  return displayed;
}

export interface AnimatedNumberProps {
  value: number;
  format?: (value: number) => string;
}

/** Renders a count-up number; `data-target` carries the FINAL value so tests can assert it without waiting. */
export function AnimatedNumber({ value, format }: AnimatedNumberProps): React.JSX.Element {
  const displayed = useCountUp(value);
  return (
    <span className="tabular-nums" data-target={value}>
      {format ? format(displayed) : displayed}
    </span>
  );
}

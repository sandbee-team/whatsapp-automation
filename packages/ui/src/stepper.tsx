'use client';

import * as React from 'react';
import { Check } from 'lucide-react';
import { cx } from './lib/cx.js';

/**
 * Stepper - horizontal (desktop) or vertical (mobile) progress indicator.
 * Carries `'use client'` for consistency with the rest of this file cluster
 * (purely presentational otherwise). Done steps show a lucide `Check` in an
 * accent circle; the current step gets `aria-current="step"` and an accent
 * ring; upcoming steps are muted. State is never colour-only: each step
 * renders a visually-hidden status word from `completedLabel` /
 * `currentLabel` / `upcomingLabel`. Below `md`, `horizontal` collapses to a
 * vertical layout via responsive classes.
 */
export interface StepperStep {
  id: string;
  label: string;
  description?: string;
}

export type StepperOrientation = 'horizontal' | 'vertical';

export interface StepperProps extends React.HTMLAttributes<HTMLOListElement> {
  steps: StepperStep[];
  /** Index of the current step. */
  current: number;
  orientation: StepperOrientation;
  completedLabel: string;
  currentLabel: string;
  upcomingLabel: string;
}

type StepStatus = 'done' | 'current' | 'upcoming';

function statusOf(index: number, current: number): StepStatus {
  if (index < current) return 'done';
  if (index === current) return 'current';
  return 'upcoming';
}

const CIRCLE_CLASSES: Record<StepStatus, string> = {
  done: 'bg-accent text-accent-fg border-accent',
  current: 'bg-surface text-accent border-accent ring-2 ring-ring ring-offset-2 ring-offset-bg',
  upcoming: 'bg-surface text-subtle border-border-strong',
};

const LABEL_CLASSES: Record<StepStatus, string> = {
  done: 'text-fg',
  current: 'text-fg font-medium',
  upcoming: 'text-subtle',
};

export function Stepper({
  steps,
  current,
  orientation,
  completedLabel,
  currentLabel,
  upcomingLabel,
  className,
  ...rest
}: StepperProps): React.JSX.Element {
  const statusLabel: Record<StepStatus, string> = {
    done: completedLabel,
    current: currentLabel,
    upcoming: upcomingLabel,
  };

  return (
    <ol
      className={cx(
        'flex flex-col gap-4',
        orientation === 'horizontal' && 'md:flex-row md:items-start md:gap-0',
        className,
      )}
      {...rest}
    >
      {steps.map((step, index) => {
        const status = statusOf(index, current);
        const isLast = index === steps.length - 1;
        return (
          <li
            key={step.id}
            aria-current={status === 'current' ? 'step' : undefined}
            className={cx(
              'flex gap-3',
              orientation === 'horizontal' &&
                'md:flex-1 md:flex-col md:items-center md:text-center',
            )}
          >
            <div
              className={cx(
                'flex flex-col items-center',
                orientation === 'horizontal' && 'md:w-full md:flex-row',
              )}
            >
              <span
                className={cx(
                  'flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-2 text-sm font-medium',
                  CIRCLE_CLASSES[status],
                )}
              >
                {status === 'done' ? (
                  <Check aria-hidden="true" size={16} />
                ) : (
                  <span aria-hidden="true">{index + 1}</span>
                )}
              </span>
              {!isLast ? (
                <span
                  aria-hidden="true"
                  className={cx(
                    'bg-border',
                    orientation === 'horizontal'
                      ? 'ml-3 h-0.5 w-4 md:mx-2 md:h-0.5 md:flex-1'
                      : 'my-1 ml-4 h-4 w-0.5',
                  )}
                />
              ) : null}
            </div>
            <div className="flex flex-col">
              <span className={cx('text-sm', LABEL_CLASSES[status])}>
                {step.label}
                <span className="sr-only">{` (${statusLabel[status]})`}</span>
              </span>
              {step.description ? (
                <span className="text-xs text-muted">{step.description}</span>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

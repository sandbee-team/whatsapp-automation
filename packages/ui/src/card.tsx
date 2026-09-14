import * as React from 'react';
import { cx } from './lib/cx.js';

/**
 * Card / CardHeader / CardTitle / CardDescription / CardBody / CardFooter -
 * purely presentational (no interactive markers of its own - `interactive`
 * only adds hover/transition classes, the caller supplies any click/keyboard
 * handling on a child control), so no `'use client'` directive.
 */
export type CardPadding = 'none' | 'sm' | 'md';

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Hover lift + shadow, for cards that act as a link/button target. */
  interactive?: boolean;
  /** Body padding shorthand applied to the root element. Default `md`. */
  padding?: CardPadding;
}

const PADDING_CLASSES: Record<CardPadding, string> = {
  none: '',
  sm: 'p-3',
  md: 'p-5',
};

export function Card({
  interactive = false,
  padding = 'md',
  className,
  ...rest
}: CardProps): React.JSX.Element {
  return (
    <div
      className={cx(
        'rounded-xl border border-border bg-surface shadow-card',
        PADDING_CLASSES[padding],
        interactive &&
          'transition duration-150 hover:-translate-y-0.5 hover:shadow-md motion-reduce:transform-none',
        className,
      )}
      {...rest}
    />
  );
}

export interface CardHeaderProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Right-aligned actions slot (e.g. a menu trigger or a small button). */
  actions?: React.ReactNode;
  /** Small uppercase label rendered above the title (e.g. "Numbers"). */
  eyebrow?: string;
}

export function CardHeader({
  actions,
  eyebrow,
  className,
  children,
  ...rest
}: CardHeaderProps): React.JSX.Element {
  return (
    <div className={cx('flex items-start justify-between gap-4 pb-4', className)} {...rest}>
      <div className="flex flex-col gap-1">
        {eyebrow ? (
          <span className="text-[11px] font-medium uppercase tracking-wider text-muted">
            {eyebrow}
          </span>
        ) : null}
        {children}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export type CardTitleProps = React.HTMLAttributes<HTMLHeadingElement>;

export function CardTitle({ className, ...rest }: CardTitleProps): React.JSX.Element {
  return <h3 className={cx('text-base font-semibold font-ui text-fg', className)} {...rest} />;
}

export type CardDescriptionProps = React.HTMLAttributes<HTMLParagraphElement>;

export function CardDescription({ className, ...rest }: CardDescriptionProps): React.JSX.Element {
  return <p className={cx('text-sm font-ui text-muted', className)} {...rest} />;
}

export type CardBodyProps = React.HTMLAttributes<HTMLDivElement>;

export function CardBody({ className, ...rest }: CardBodyProps): React.JSX.Element {
  return <div className={cx('text-sm font-ui text-fg', className)} {...rest} />;
}

export type CardFooterProps = React.HTMLAttributes<HTMLDivElement>;

export function CardFooter({ className, ...rest }: CardFooterProps): React.JSX.Element {
  return (
    <div
      className={cx('flex items-center gap-2 border-t border-border pt-4 mt-4', className)}
      {...rest}
    />
  );
}

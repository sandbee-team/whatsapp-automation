import * as React from 'react';
import { cx } from '@wp/ui';

/**
 * page-header.tsx (P28 Unit U6, step 9) - identical anatomy to
 * app/frontend's PageHeader (design brief section 3): `h1`, one-line
 * description, right-aligned actions, optional tabs row. Every admin route
 * renders exactly one.
 */
export interface PageHeaderProps {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  tabs?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}

export function PageHeader({
  title,
  description,
  actions,
  tabs,
  children,
  className,
}: PageHeaderProps): React.JSX.Element {
  return (
    <div className={cx('flex flex-col gap-4 pb-6', className)}>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold font-ui tracking-tight text-fg sm:text-3xl">
            {title}
          </h1>
          {description ? (
            <p className="text-sm font-ui text-muted sm:text-base">{description}</p>
          ) : null}
        </div>
        {actions ? (
          <div className="flex flex-wrap items-center gap-2 sm:shrink-0">{actions}</div>
        ) : null}
      </div>

      {tabs ? <div>{tabs}</div> : null}
      {children}
    </div>
  );
}

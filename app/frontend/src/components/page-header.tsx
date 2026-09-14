import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { cx } from '@wp/ui';

/**
 * PageHeader (panel refresh spec section 4, unit S1) - the one page-header
 * every route renders exactly once. Optional breadcrumbs row, an optional
 * small uppercase eyebrow above the title, an `h1`, a one-line description,
 * right-aligned actions that wrap on mobile, and an optional tabs row
 * underneath. Purely presentational: breadcrumb targets are plain `Link`s,
 * actions/tabs are caller-supplied nodes.
 */
export interface PageHeaderBreadcrumb {
  label: string;
  to?: string;
}

export interface PageHeaderProps {
  title: string;
  /** Small uppercase label rendered above the title. */
  eyebrow?: string;
  description?: string;
  actions?: React.ReactNode;
  breadcrumbs?: PageHeaderBreadcrumb[];
  tabs?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}

export function PageHeader({
  title,
  eyebrow,
  description,
  actions,
  breadcrumbs,
  tabs,
  children,
  className,
}: PageHeaderProps): React.JSX.Element {
  return (
    <div className={cx('flex flex-col gap-4 pb-6', className)}>
      {breadcrumbs && breadcrumbs.length > 0 ? (
        <nav aria-label="Breadcrumb" className="flex items-center gap-1 text-xs text-muted">
          {breadcrumbs.map((crumb, index) => (
            <span key={`${crumb.label}-${String(index)}`} className="flex items-center gap-1">
              {index > 0 ? <span aria-hidden="true">/</span> : null}
              {crumb.to ? (
                <Link to={crumb.to as never} className="hover:text-fg">
                  {crumb.label}
                </Link>
              ) : (
                <span>{crumb.label}</span>
              )}
            </span>
          ))}
        </nav>
      ) : null}

      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-1">
          {eyebrow ? (
            <span className="text-[11px] font-medium uppercase tracking-wider text-muted">
              {eyebrow}
            </span>
          ) : null}
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

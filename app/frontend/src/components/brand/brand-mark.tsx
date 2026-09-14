import * as React from 'react';
import { Hexagon } from 'lucide-react';
import { cx, useT } from '@wp/ui';
import { BRAND_LOGO_SRC, BRAND_LOGO_SRC_SET, SANDBEE_SITE_URL } from './brand.js';

/**
 * BrandMark (panel-refresh spec section 9) - the single brand row used by the
 * sidebar, mobile nav, auth layout and onboarding rail: a rounded logo tile
 * linking out to `sandbee.in` in a new tab, plus (when `showText`) a two-line
 * "WA Automation" / "by Sandbee" block. `variant` only changes text colour so
 * the mark reads correctly on the sidebar's dark surface vs. the light auth
 * card; the tile itself (ring + rounded corners) never changes. If the logo
 * asset request fails (defect B: an empty white circle was observed during a
 * dev-server hiccup) the tile falls back to a `Hexagon` icon on an accent-soft
 * background rather than rendering nothing.
 */
export type BrandMarkSize = 'sm' | 'md' | 'lg';
export type BrandMarkVariant = 'sidebar' | 'auth';

const TILE_PX: Record<BrandMarkSize, number> = { sm: 32, md: 36, lg: 44 };

const PRODUCT_TEXT_CLASS: Record<BrandMarkVariant, string> = {
  sidebar: 'text-sidebar-fg',
  auth: 'text-fg',
};

const BY_TEXT_CLASS: Record<BrandMarkVariant, string> = {
  sidebar: 'text-sidebar-muted',
  auth: 'text-muted',
};

export interface BrandMarkProps {
  size?: BrandMarkSize;
  showText?: boolean;
  variant?: BrandMarkVariant;
  className?: string;
  /** Extra muted line rendered under "by Sandbee" (e.g. the workspace name). */
  meta?: string;
}

export function BrandMark({
  size = 'md',
  showText = true,
  variant = 'sidebar',
  className,
  meta,
}: BrandMarkProps): React.JSX.Element {
  const t = useT();
  const tilePx = TILE_PX[size];
  const [imageFailed, setImageFailed] = React.useState(false);

  return (
    <a
      href={SANDBEE_SITE_URL}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={t('brand.visitSite')}
      data-testid="brand-mark"
      className={cx('group flex min-w-0 items-center gap-2', className)}
    >
      <span
        className="shrink-0 overflow-hidden rounded-xl ring-1 ring-border/60 transition-transform group-hover:scale-[1.03] motion-reduce:transform-none"
        style={{ width: tilePx, height: tilePx }}
      >
        {imageFailed ? (
          <span
            className="flex h-full w-full items-center justify-center bg-accent-soft text-accent"
            data-testid="brand-mark-fallback"
          >
            <Hexagon aria-hidden size={18} strokeWidth={1.75} />
          </span>
        ) : (
          <img
            src={BRAND_LOGO_SRC}
            srcSet={BRAND_LOGO_SRC_SET}
            alt=""
            width={tilePx}
            height={tilePx}
            className="block h-full w-full"
            onError={() => setImageFailed(true)}
          />
        )}
      </span>
      {showText ? (
        <span className="flex min-w-0 flex-col leading-tight">
          <span
            className={cx(
              'truncate text-sm font-semibold tracking-tight',
              PRODUCT_TEXT_CLASS[variant],
            )}
          >
            {t('brand.product')}
          </span>
          <span className={cx('truncate text-xs', BY_TEXT_CLASS[variant])}>
            {meta ? `${t('brand.by')} · ${meta}` : t('brand.by')}
          </span>
        </span>
      ) : null}
    </a>
  );
}

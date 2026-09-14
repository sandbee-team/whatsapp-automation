import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { Skeleton, useT } from '@wp/ui';
import { useWalletSummary } from '../../features/wallet/api.js';
import { paiseToRupees } from '../../features/wallet/money.js';

/**
 * SidebarWalletCard (panel refresh spec section 4, unit S1) - the sidebar
 * footer's wallet mini-card: row 1 pairs the eyebrow with the "Add funds"
 * link on the same line, row 2 is the balance (`paiseToRupees`), row 3 is an
 * honest "roughly N messages left" estimate line built from the existing
 * `estimatedMessagesRemaining` field. Loading renders a skeleton; a fetch
 * error hides the whole card rather than showing a stale/undefined balance
 * (the sidebar has no room for an `ErrorState` + retry affordance, and the
 * wallet screen itself already owns that surface). Hidden entirely in rail
 * (collapsed) mode by the caller (`Sidebar`), never rendered here with a
 * truncated layout.
 *
 * Defect A fix (sidebar overflow at 768px-tall viewports): the card is
 * compacted (eyebrow + link share row 1, `text-base` balance) and hides
 * itself below a 780px-tall viewport via the arbitrary
 * `[@media(max-height:780px)]:hidden` variant, so short laptops never scroll
 * to see the nav items below the fold.
 */
export function SidebarWalletCard(): React.JSX.Element | null {
  const t = useT();
  const { data: summary, isLoading, isError } = useWalletSummary();

  if (isError) {
    return null;
  }

  return (
    <div
      className="flex flex-col gap-1 rounded-xl bg-surface-2 p-3 [@media(max-height:780px)]:hidden"
      data-testid="sidebar-wallet-card"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-medium uppercase tracking-wider text-sidebar-muted">
          {t('shell.wallet.eyebrow')}
        </span>
        <Link
          to="/wallet"
          className="text-xs font-medium font-ui text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ring-offset-bg"
        >
          {t('shell.wallet.addFunds')}
        </Link>
      </div>
      {isLoading || !summary ? (
        <>
          <Skeleton className="h-5 w-20" />
          <Skeleton className="h-3 w-32" />
        </>
      ) : (
        <>
          <span className="text-base font-semibold font-ui tabular-nums text-sidebar-fg">
            {paiseToRupees(summary.balanceMinor)}
          </span>
          <span className="text-[11px] leading-snug text-sidebar-muted">
            {t('shell.wallet.estimateLine', { count: summary.estimatedMessagesRemaining })}
          </span>
        </>
      )}
    </div>
  );
}

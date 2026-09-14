import * as React from 'react';
import { Sheet, useT } from '@wp/ui';
import { Sidebar } from './sidebar.js';
import type { RealtimeConnectionState } from '../../lib/sse.js';

/**
 * MobileNav (P26b U2, design brief section 3) - the hamburger-triggered left
 * `Sheet` shown below `lg`, reusing `Sidebar`'s `variant="mobile"` render (no
 * collapse rail, no localStorage toggle) so the same `NAV_GROUPS` render is
 * never duplicated.
 */
export interface MobileNavProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyName: string;
  realtimeState: RealtimeConnectionState;
}

export function MobileNav({
  open,
  onOpenChange,
  companyName,
  realtimeState,
}: MobileNavProps): React.JSX.Element {
  const t = useT();

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      side="left"
      size="sm"
      title={t('app.name')}
      closeLabel={t('common.close')}
    >
      <div className="-m-6 h-[calc(100%+3rem)]">
        <Sidebar
          companyName={companyName}
          realtimeState={realtimeState}
          collapsed={false}
          onCollapsedChange={() => undefined}
          variant="mobile"
        />
      </div>
    </Sheet>
  );
}

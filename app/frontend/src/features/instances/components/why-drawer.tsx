import * as React from 'react';
import { Sheet, useT } from '@wp/ui';
import type { HealthWhyResult } from '../api.js';
import { WhyDrawerContent } from './why-drawer-content.js';

/**
 * WhyDrawer (P17 U5; P26b U3 extracts the body into `WhyDrawerContent` so
 * the instance detail page's Health tab can render the identical content
 * inline, without a second Sheet) - the health-why breakdown: all twelve
 * signals (never a subset), each row showing
 * `measuredValue`/`window`/`evidenceCount` when present. A `scored: false`
 * row NEVER renders a bare/silent score - it shows the honest
 * `signalNotScored` (observed, 0 points) or `signalNotEnoughData` (below the
 * evidence gate) label via `exemptReason`, per the contract's own doc.
 */
export interface WhyDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  data: HealthWhyResult | undefined;
}

export function WhyDrawer({ open, onOpenChange, data }: WhyDrawerProps): React.JSX.Element {
  const t = useT();

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={t('instances.whyDrawer.title')}
      closeLabel={t('common.close')}
    >
      <WhyDrawerContent data={data} />
    </Sheet>
  );
}

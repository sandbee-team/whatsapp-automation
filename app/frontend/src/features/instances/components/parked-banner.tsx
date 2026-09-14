import * as React from 'react';
import { Badge, useT } from '@wp/ui';

/**
 * ParkedBanner (P17 U5) - renders the VERBATIM `INSTANCE_CARD_COPY.parked`
 * domain constant (via `t('instances.card.parked')`, whose `en` value is
 * byte-identical to that constant - `packages/i18n/test/catalogue-copy-
 * parity.test.ts` pins it). `hi` is a faithful translation carrying no
 * banned claim in either language (`check-copy.ts` scans both catalogue
 * files tree-wide).
 */
export function ParkedBanner(): React.JSX.Element {
  const t = useT();
  return (
    <div
      role="status"
      data-testid="parked-banner"
      className="flex items-center gap-2 rounded-md border border-warning bg-surface p-3"
    >
      <Badge tone="warning">{t('instances.connect.parked.title')}</Badge>
      <p className="text-sm font-ui text-fg">{t('instances.card.parked')}</p>
    </div>
  );
}

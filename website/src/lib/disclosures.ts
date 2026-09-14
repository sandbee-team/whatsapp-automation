import * as React from 'react';

/**
 * disclosures.ts (P29 U2) - re-exports the verbatim disclosure copy from
 * `@wp/domain` (single source of truth) plus a small Server Component to
 * render one. This file's own prose must not spell any co-presence token -
 * only the re-exported identifier names appear here. Plain `.ts` (not
 * `.tsx`): uses `React.createElement` instead of JSX so the file keeps the
 * name the brief specifies.
 */
export {
  SAFE_MODE_DISCLAIMER,
  BROADCAST_DISCLOSURE,
  GROUP_RISK_DISCLOSURE,
  BROADCAST_ESTIMATE_CAVEAT,
} from '@wp/domain';
export { PARKED_COPY, PARKED_BUFFER_CAVEAT } from '@wp/domain';

export interface DisclosureProps {
  text: string;
  id?: string;
}

export function Disclosure({ text, id }: DisclosureProps): React.ReactElement {
  return React.createElement(
    'p',
    { role: 'note', id, className: 'text-sm text-muted border-l-2 border-border-strong pl-3' },
    text,
  );
}

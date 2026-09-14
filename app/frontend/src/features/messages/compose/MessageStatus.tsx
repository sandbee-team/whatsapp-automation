import * as React from 'react';
import { Clock, Check } from 'lucide-react';
import { COMPOSER_QUEUED_COPY, INSTANCE_OFFLINE_COPY } from '@wp/domain';
import { Badge, useT } from '@wp/ui';
import type { ComposeStage } from './useComposer.js';

/**
 * MessageStatus (P11 U6a; P26b U4 restyle) - the ONE place a submitted
 * message's status is rendered, split out of `Composer.tsx` for max-lines
 * discipline. Binding honesty rule (phase gotcha, verbatim): "never a tick
 * on an unsent message" - a queued CLOCK icon renders for `'queued'`/
 * `'offline'`, a tick icon renders ONLY for `'sent'` (driven exclusively by
 * `useComposer`'s SSE subscription, never by this component's own timer or
 * by the submit response alone). `COMPOSER_QUEUED_COPY`/
 * `INSTANCE_OFFLINE_COPY` are the exact, already-`check-copy`-clean strings
 * from `@wp/domain` - never re-worded here. The status word (never colour
 * alone) always ships alongside the icon inside the `Badge`.
 */
export function MessageStatus({ stage }: { stage: ComposeStage }): React.JSX.Element | null {
  const t = useT();

  if (stage === 'queued' || stage === 'offline') {
    return (
      <p data-testid="compose-status" className="flex items-center gap-2 text-sm font-ui text-fg">
        <Badge tone="info" data-testid="compose-status-clock">
          <Clock aria-hidden="true" size={14} />
          {stage === 'queued' ? COMPOSER_QUEUED_COPY : INSTANCE_OFFLINE_COPY}
        </Badge>
      </p>
    );
  }

  if (stage === 'sent') {
    return (
      <p data-testid="compose-status" className="flex items-center gap-2 text-sm font-ui text-fg">
        <Badge tone="success" data-testid="compose-status-tick">
          <Check aria-hidden="true" size={14} />
          {t('messages.status.sent')}
        </Badge>
      </p>
    );
  }

  return null;
}

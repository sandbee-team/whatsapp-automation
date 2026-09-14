import * as React from 'react';
import { AlertTriangle } from 'lucide-react';
import { Alert, Button, useT } from '@wp/ui';
import { useDuplicateFanoutAcks } from './useDuplicateFanoutAcks.js';

/**
 * DuplicateFanoutBanner (P14 Unit U7, step 3; P26b U4 restyle) - the
 * duplicate fan-out ack surface's panel UI, restyled as an `Alert` per item.
 * Pure render (`useDuplicateFanoutAcks.ts` owns all state/API calls, same
 * split idiom as `Composer.tsx`/`useComposer.ts` and
 * `UnresolvedSendsPanel.tsx`/`useUnresolvedSends.ts`).
 *
 * HONEST COPY ONLY (safety-compliance skill, binding): every string states
 * what happened (an identical message is headed to N recipients today),
 * what is preserved (the messages are queued, nothing failed or lost), when
 * it resumes (immediately after confirming), and what the user can do
 * (confirm, or edit the campaign) - NEVER a claim that confirming or any
 * guard here prevents a WhatsApp restriction. Counts only, per `api.ts`'s
 * own doc: this component never receives or renders message body content.
 */
export function DuplicateFanoutBanner(): React.JSX.Element | null {
  const t = useT();
  const { stage, items, confirmItem } = useDuplicateFanoutAcks();

  if (stage === 'loading' || stage === 'error' || items.length === 0) {
    return null;
  }

  return (
    <div data-testid="duplicate-fanout-banner" className="flex flex-col gap-3">
      {items.map((item) => (
        <Alert
          key={item.fingerprintHex}
          data-testid={`duplicate-fanout-item-${item.fingerprintHex}`}
          tone="warning"
          icon={<AlertTriangle size={18} />}
          title={t('pacing.fanoutBanner.title')}
          body={t('pacing.fanoutBanner.body', { count: item.recipientCount })}
          action={
            <div className="flex flex-col gap-2">
              <p className="text-xs font-ui text-muted">{t('pacing.fanoutBanner.editHint')}</p>

              {item.failed ? (
                <p role="alert" className="text-sm font-ui text-danger">
                  {t('pacing.fanoutBanner.error')}
                </p>
              ) : null}

              <div>
                <Button
                  type="button"
                  size="sm"
                  variant="primary"
                  data-testid={`duplicate-fanout-confirm-${item.fingerprintHex}`}
                  loading={item.pending}
                  loadingLabel={t('common.loading')}
                  disabled={item.pending}
                  onClick={() => confirmItem(item.fingerprintHex)}
                >
                  {t('pacing.fanoutBanner.confirmButton', { count: item.recipientCount })}
                </Button>
              </div>
            </div>
          }
        />
      ))}
    </div>
  );
}

import * as React from 'react';
import { Button, Sheet, useT } from '@wp/ui';

/**
 * KeyOnceDialog (go-live U5) - shown right after `apiKeysContract.create`
 * succeeds. The full API key is returned in the clear ONCE (contract doc:
 * "the raw one-time `key`... appears in EXACTLY ONE response shape") - this
 * dialog is that one surface: a copy-to-clipboard button plus an explicit
 * "will not be shown again" warning, built on `@wp/ui`'s `Sheet` (the
 * established modal primitive, ADR 0007 Base UI Dialog), copied from
 * `features/webhooks/components/secret-once-dialog.tsx`. Never persists
 * `apiKey` itself - the caller owns that value only for the lifetime of this
 * render, and must clear it from both component state AND the react-query
 * cache on dismiss.
 */
export interface KeyOnceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  apiKey: string;
}

export function KeyOnceDialog({
  open,
  onOpenChange,
  apiKey,
}: KeyOnceDialogProps): React.JSX.Element {
  const t = useT();
  const [copied, setCopied] = React.useState(false);

  const onCopy = (): void => {
    void navigator.clipboard.writeText(apiKey).then(() => {
      setCopied(true);
    });
  };

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={t('apiKeys.keyOnce.title')}
      description={t('apiKeys.keyOnce.body')}
      closeLabel={t('common.close')}
    >
      <div className="flex flex-col gap-4">
        <code
          data-testid="api-key-value"
          className="break-all rounded-md border border-border bg-surface p-3 text-sm font-ui text-fg"
        >
          {apiKey}
        </code>

        <Button type="button" data-testid="api-key-copy" onClick={onCopy}>
          {copied ? t('apiKeys.keyOnce.copiedLabel') : t('apiKeys.keyOnce.copyButton')}
        </Button>

        <Button
          type="button"
          variant="secondary"
          data-testid="api-key-done"
          onClick={() => onOpenChange(false)}
        >
          {t('apiKeys.keyOnce.doneButton')}
        </Button>
      </div>
    </Sheet>
  );
}

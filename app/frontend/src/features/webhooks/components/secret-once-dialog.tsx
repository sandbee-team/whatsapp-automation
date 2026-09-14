import * as React from 'react';
import { Button, Sheet, useT } from '@wp/ui';

/**
 * SecretOnceDialog (P15 U6, step 9) - shown right after
 * `webhooksContract.create` succeeds. The endpoint's signing secret is
 * returned in the clear ONCE (contract doc: "secrets shown once, never
 * echoed back") - this dialog is that one surface: a copy-to-clipboard
 * button plus an explicit "will not be shown again" warning, built on
 * `@wp/ui`'s `Sheet` (the established modal primitive, ADR 0007 Base UI
 * Dialog). Never persists `secret` itself - the caller owns that value only
 * for the lifetime of this render.
 */
export interface SecretOnceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  secret: string;
}

export function SecretOnceDialog({
  open,
  onOpenChange,
  secret,
}: SecretOnceDialogProps): React.JSX.Element {
  const t = useT();
  const [copied, setCopied] = React.useState(false);

  const onCopy = (): void => {
    void navigator.clipboard.writeText(secret).then(() => {
      setCopied(true);
    });
  };

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={t('webhooks.secretOnce.title')}
      description={t('webhooks.secretOnce.body')}
      closeLabel={t('common.close')}
    >
      <div className="flex flex-col gap-4">
        <code
          data-testid="webhook-secret-value"
          className="break-all rounded-md border border-border bg-surface p-3 text-sm font-ui text-fg"
        >
          {secret}
        </code>

        <Button type="button" data-testid="webhook-secret-copy" onClick={onCopy}>
          {copied ? t('webhooks.secretOnce.copiedLabel') : t('webhooks.secretOnce.copyButton')}
        </Button>

        <Button
          type="button"
          variant="secondary"
          data-testid="webhook-secret-done"
          onClick={() => onOpenChange(false)}
        >
          {t('webhooks.secretOnce.doneButton')}
        </Button>
      </div>
    </Sheet>
  );
}

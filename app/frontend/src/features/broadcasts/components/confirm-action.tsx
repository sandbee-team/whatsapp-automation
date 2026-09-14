import { Button, Card, CardBody, CardFooter } from '@wp/ui';

/**
 * ConfirmAction (P23a Unit U5) - an inline confirm block used before Pause,
 * Resume and Cancel mutations (core invariant: a destructive/state-changing
 * action never fires on a single click). `role="dialog"` so it is
 * discoverable by assistive tech and by test queries the same way a modal
 * would be, even though it renders inline (a `Card`) rather than in a
 * portal - the previous unit's `PreflightPanel` established the pattern of
 * rendering confirmation surfaces inline in this feature.
 */
export interface ConfirmActionProps {
  message: React.ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
}

export function ConfirmAction({
  message,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
  busy = false,
}: ConfirmActionProps): React.JSX.Element {
  return (
    <Card role="dialog" aria-modal="true" data-testid="confirm-action">
      <CardBody>{message}</CardBody>
      <CardFooter>
        <Button type="button" variant="secondary" onClick={onCancel} disabled={busy}>
          {cancelLabel}
        </Button>
        <Button type="button" variant="primary" onClick={onConfirm} disabled={busy}>
          {confirmLabel}
        </Button>
      </CardFooter>
    </Card>
  );
}

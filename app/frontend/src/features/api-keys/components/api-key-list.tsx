import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Badge,
  Button,
  Card,
  CardBody,
  EmptyState,
  ErrorState,
  Sheet,
  SkeletonRows,
  useT,
} from '@wp/ui';
import { KeyRound } from 'lucide-react';
import { PageHeader } from '../../../components/page-header.js';
import { apiKeyKeys } from '../keys.js';
import { listApiKeys, revokeApiKey, type CreateApiKeyResult } from '../api.js';
import { ApiError } from '../../../lib/api-client.js';
import { ApiKeyForm } from './api-key-form.js';
import { KeyOnceDialog } from './key-once-dialog.js';

/**
 * ApiKeyList (go-live U5) - the `/settings/api-keys` screen: fetches
 * `apiKeysContract.list`, states loading/empty/error honestly (never a
 * fabricated row), and opens `ApiKeyForm` in a `Sheet` for creation. A
 * successful create immediately shows `KeyOnceDialog` (the one place the new
 * key is ever visible) and invalidates the list query so the new row appears
 * without a page reload. Dismissing the dialog clears the raw key from BOTH
 * this component's state and the react-query cache (the cache never held it
 * in the first place - `createApiKey`'s result is never written into the
 * `list` query cache, only used transiently for this dialog).
 *
 * Each row shows the masked key (`keyPrefix`+`last4`, never the full
 * secret), created/last-used timestamps, and a revoke action gated behind an
 * explicit inline confirm step (never a single click can revoke a key).
 * Revoked rows stay visible, visually de-emphasised via `variant="muted"` on
 * `Card` plus a `Badge`/`revokedAt` line - never color alone - and their
 * revoke button is removed entirely.
 */
export function ApiKeyList(): React.JSX.Element {
  const t = useT();
  const queryClient = useQueryClient();
  const [formOpen, setFormOpen] = React.useState(false);
  const [newKeyResult, setNewKeyResult] = React.useState<CreateApiKeyResult | null>(null);
  const [confirmingRevokeId, setConfirmingRevokeId] = React.useState<string | null>(null);
  const [revokeError, setRevokeError] = React.useState<string | null>(null);
  const [revokingId, setRevokingId] = React.useState<string | null>(null);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: apiKeyKeys.list(),
    queryFn: listApiKeys,
  });

  const onCreated = (result: CreateApiKeyResult): void => {
    setFormOpen(false);
    setNewKeyResult(result);
    void queryClient.invalidateQueries({ queryKey: apiKeyKeys.list() });
  };

  const onDismissKeyOnce = (open: boolean): void => {
    if (open) return;
    // The raw key must be gone from state AND never linger in the query
    // cache: `newKeyResult` (holding `key`) is component state only, and
    // clearing it here is the whole story - the list query cache is
    // populated exclusively by `listApiKeys`, whose schema never carries
    // `key` at all.
    setNewKeyResult(null);
  };

  const onConfirmRevoke = async (id: string): Promise<void> => {
    setRevokeError(null);
    setRevokingId(id);
    try {
      await revokeApiKey(id);
      setConfirmingRevokeId(null);
      void queryClient.invalidateQueries({ queryKey: apiKeyKeys.list() });
    } catch (error) {
      setRevokeError(error instanceof ApiError ? error.message : t('apiKeys.list.revokeError'));
    } finally {
      setRevokingId(null);
    }
  };

  return (
    <div data-testid="api-keys-screen" className="flex flex-col gap-6">
      <PageHeader
        title={t('apiKeys.title')}
        description={t('apiKeys.subtitle')}
        actions={
          <Button type="button" data-testid="api-keys-add-button" onClick={() => setFormOpen(true)}>
            {t('apiKeys.addButton')}
          </Button>
        }
      />

      {isLoading ? (
        <div data-testid="api-keys-loading">
          <SkeletonRows rows={3} columns={2} />
        </div>
      ) : null}

      {isError ? (
        <div data-testid="api-keys-error">
          <ErrorState
            title={t('apiKeys.error')}
            retryAction={
              <Button type="button" variant="secondary" size="sm" onClick={() => void refetch()}>
                {t('common.retry')}
              </Button>
            }
          />
        </div>
      ) : null}

      {!isLoading && !isError && (data?.length ?? 0) === 0 ? (
        <EmptyState
          icon={<KeyRound aria-hidden size={20} />}
          title={t('apiKeys.empty.title')}
          body={t('apiKeys.empty.body')}
        />
      ) : null}

      {!isLoading && !isError && data && data.length > 0 ? (
        <div className="flex flex-col gap-3">
          {data.map((key) => {
            const isRevoked = key.revokedAt !== null;
            const isConfirmingRevoke = confirmingRevokeId === key.id;
            const isRevoking = revokingId === key.id;

            return (
              <Card
                key={key.id}
                data-testid={`api-key-row-${key.id}`}
                className={isRevoked ? 'opacity-60' : undefined}
              >
                <CardBody className="flex flex-col gap-2">
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-ui text-sm text-fg">{key.name}</span>
                    <Badge tone={isRevoked ? 'danger' : 'success'}>
                      {isRevoked ? t('apiKeys.list.revokedBadge') : t('apiKeys.list.activeBadge')}
                    </Badge>
                  </div>

                  <code
                    data-testid={`api-key-masked-${key.id}`}
                    className="break-all rounded-md border border-border bg-surface p-2 text-sm font-ui text-fg"
                  >
                    {key.keyPrefix}
                    {'…'}
                    {key.last4}
                  </code>

                  <span className="text-sm font-ui text-muted">
                    {t('apiKeys.list.createdLabel')} {new Date(key.createdAt).toLocaleString()}
                  </span>
                  <span className="text-sm font-ui text-muted">
                    {t('apiKeys.list.lastUsedLabel')}{' '}
                    {key.lastUsedAt
                      ? new Date(key.lastUsedAt).toLocaleString()
                      : t('apiKeys.list.neverUsed')}
                  </span>

                  {isRevoked ? (
                    <span
                      data-testid={`api-key-revoked-at-${key.id}`}
                      className="text-sm font-ui text-muted"
                    >
                      {t('apiKeys.list.revokedAtLabel')}{' '}
                      {key.revokedAt ? new Date(key.revokedAt).toLocaleString() : ''}
                    </span>
                  ) : null}

                  {!isRevoked ? (
                    <div className="flex items-center gap-2">
                      {!isConfirmingRevoke ? (
                        <Button
                          type="button"
                          variant="danger"
                          size="sm"
                          data-testid={`api-key-revoke-button-${key.id}`}
                          onClick={() => {
                            setRevokeError(null);
                            setConfirmingRevokeId(key.id);
                          }}
                        >
                          {t('apiKeys.list.revokeButton')}
                        </Button>
                      ) : (
                        <div
                          data-testid={`api-key-revoke-confirm-${key.id}`}
                          className="flex items-center gap-2"
                        >
                          <span className="text-sm font-ui text-fg">
                            {t('apiKeys.list.revokeConfirmPrompt')}
                          </span>
                          <Button
                            type="button"
                            variant="danger"
                            size="sm"
                            data-testid={`api-key-revoke-confirm-button-${key.id}`}
                            loading={isRevoking}
                            loadingLabel={t('common.loading')}
                            onClick={() => void onConfirmRevoke(key.id)}
                          >
                            {t('apiKeys.list.revokeConfirmButton')}
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            data-testid={`api-key-revoke-cancel-button-${key.id}`}
                            onClick={() => setConfirmingRevokeId(null)}
                          >
                            {t('apiKeys.list.revokeCancelButton')}
                          </Button>
                        </div>
                      )}
                    </div>
                  ) : null}

                  {isConfirmingRevoke && revokeError ? (
                    <p
                      role="alert"
                      data-testid={`api-key-revoke-error-${key.id}`}
                      className="text-sm font-ui text-danger"
                    >
                      {revokeError}
                    </p>
                  ) : null}
                </CardBody>
              </Card>
            );
          })}
        </div>
      ) : null}

      <Sheet
        open={formOpen}
        onOpenChange={setFormOpen}
        title={t('apiKeys.form.title')}
        closeLabel={t('common.close')}
      >
        <ApiKeyForm onCreated={onCreated} />
      </Sheet>

      <KeyOnceDialog
        open={newKeyResult !== null}
        onOpenChange={onDismissKeyOnce}
        apiKey={newKeyResult?.key ?? ''}
      />
    </div>
  );
}

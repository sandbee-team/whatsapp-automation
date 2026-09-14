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
import { Webhook } from 'lucide-react';
import { PageHeader } from '../../../components/page-header.js';
import { webhookKeys } from '../keys.js';
import {
  listWebhookEndpoints,
  deleteWebhookEndpoint,
  testWebhookEndpoint,
  type CreateWebhookEndpointResult,
} from '../api.js';
import { ApiError } from '../../../lib/api-client.js';
import { EndpointForm } from './endpoint-form.js';
import { SecretOnceDialog } from './secret-once-dialog.js';
import { DisabledBanner } from './disabled-banner.js';

/**
 * EndpointList (P15 U6, step 9; U6b, step 10) - the `/settings/webhooks`
 * screen: fetches `webhooksContract.list`, states loading/empty/error
 * honestly (never a fabricated row), and opens `EndpointForm` in a `Sheet`
 * for creation. A successful create immediately shows `SecretOnceDialog`
 * (the one place the new secret is ever visible) and invalidates the list
 * query so the new row appears without a page reload.
 *
 * Each row also carries a "send test event" action (fires the SAME
 * sign+dispatch path a real event uses - the result copy states the test
 * delivery as queued/attempted, never "instant"/"guaranteed") and a delete
 * action gated behind an explicit inline confirm step (never a single
 * click can delete an endpoint).
 */
export function EndpointList(): React.JSX.Element {
  const t = useT();
  const queryClient = useQueryClient();
  const [formOpen, setFormOpen] = React.useState(false);
  const [newSecretResult, setNewSecretResult] = React.useState<CreateWebhookEndpointResult | null>(
    null,
  );
  const [testState, setTestState] = React.useState<
    Record<string, { pending: boolean; message: string | null; isError: boolean }>
  >({});
  const [confirmingDeleteId, setConfirmingDeleteId] = React.useState<string | null>(null);
  const [deleteError, setDeleteError] = React.useState<string | null>(null);
  const [deletingId, setDeletingId] = React.useState<string | null>(null);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: webhookKeys.list(),
    queryFn: listWebhookEndpoints,
  });

  const onCreated = (result: CreateWebhookEndpointResult): void => {
    setFormOpen(false);
    setNewSecretResult(result);
    void queryClient.invalidateQueries({ queryKey: webhookKeys.list() });
  };

  const onReEnabled = (): void => {
    void queryClient.invalidateQueries({ queryKey: webhookKeys.list() });
  };

  const onSendTest = async (id: string): Promise<void> => {
    setTestState((prev) => ({ ...prev, [id]: { pending: true, message: null, isError: false } }));
    try {
      await testWebhookEndpoint(id);
      setTestState((prev) => ({
        ...prev,
        [id]: { pending: false, message: t('webhooks.list.testResultSuccess'), isError: false },
      }));
    } catch (error) {
      const message =
        error instanceof ApiError ? error.message : t('webhooks.list.testResultError');
      setTestState((prev) => ({ ...prev, [id]: { pending: false, message, isError: true } }));
    }
  };

  const onConfirmDelete = async (id: string): Promise<void> => {
    setDeleteError(null);
    setDeletingId(id);
    try {
      await deleteWebhookEndpoint(id);
      setConfirmingDeleteId(null);
      void queryClient.invalidateQueries({ queryKey: webhookKeys.list() });
    } catch (error) {
      setDeleteError(error instanceof ApiError ? error.message : t('webhooks.list.deleteError'));
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div data-testid="webhooks-screen" className="flex flex-col gap-6">
      <PageHeader
        title={t('webhooks.title')}
        description={t('webhooks.subtitle')}
        actions={
          <Button type="button" data-testid="webhooks-add-button" onClick={() => setFormOpen(true)}>
            {t('webhooks.addButton')}
          </Button>
        }
      />

      {isLoading ? (
        <div data-testid="webhooks-loading">
          <SkeletonRows rows={3} columns={2} />
        </div>
      ) : null}

      {isError ? (
        <div data-testid="webhooks-error">
          <ErrorState
            title={t('webhooks.error')}
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
          icon={<Webhook aria-hidden size={20} />}
          title={t('webhooks.empty.title')}
          body={t('webhooks.empty.body')}
        />
      ) : null}

      {!isLoading && !isError && data && data.length > 0 ? (
        <div className="flex flex-col gap-3">
          {data.map((endpoint) => {
            const test = testState[endpoint.id];
            const isConfirmingDelete = confirmingDeleteId === endpoint.id;
            const isDeleting = deletingId === endpoint.id;

            return (
              <Card key={endpoint.id} data-testid={`webhook-endpoint-${endpoint.id}`}>
                <CardBody className="flex flex-col gap-2">
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-mono text-sm font-ui text-fg">{endpoint.url}</span>
                    <Badge tone={endpoint.enabled ? 'success' : 'danger'}>
                      {endpoint.enabled
                        ? t('webhooks.list.enabledBadge')
                        : t('webhooks.list.disabledBadge')}
                    </Badge>
                  </div>
                  {!endpoint.enabled ? (
                    <DisabledBanner
                      id={endpoint.id}
                      disabledReason={endpoint.disabledReason}
                      onReEnabled={onReEnabled}
                    />
                  ) : null}

                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      data-testid={`webhook-test-button-${endpoint.id}`}
                      loading={test?.pending ?? false}
                      loadingLabel={t('webhooks.list.testSending')}
                      onClick={() => void onSendTest(endpoint.id)}
                    >
                      {t('webhooks.list.testButton')}
                    </Button>

                    {!isConfirmingDelete ? (
                      <Button
                        type="button"
                        variant="danger"
                        size="sm"
                        data-testid={`webhook-delete-button-${endpoint.id}`}
                        onClick={() => {
                          setDeleteError(null);
                          setConfirmingDeleteId(endpoint.id);
                        }}
                      >
                        {t('webhooks.list.deleteButton')}
                      </Button>
                    ) : (
                      <div
                        data-testid={`webhook-delete-confirm-${endpoint.id}`}
                        className="flex items-center gap-2"
                      >
                        <span className="text-sm font-ui text-fg">
                          {t('webhooks.list.deleteConfirmPrompt')}
                        </span>
                        <Button
                          type="button"
                          variant="danger"
                          size="sm"
                          data-testid={`webhook-delete-confirm-button-${endpoint.id}`}
                          loading={isDeleting}
                          loadingLabel={t('common.loading')}
                          onClick={() => void onConfirmDelete(endpoint.id)}
                        >
                          {t('webhooks.list.deleteConfirmButton')}
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          data-testid={`webhook-delete-cancel-button-${endpoint.id}`}
                          onClick={() => setConfirmingDeleteId(null)}
                        >
                          {t('webhooks.list.deleteCancelButton')}
                        </Button>
                      </div>
                    )}
                  </div>

                  {test?.message ? (
                    <p
                      role={test.isError ? 'alert' : 'status'}
                      data-testid={`webhook-test-result-${endpoint.id}`}
                      className={`text-sm font-ui ${test.isError ? 'text-danger' : 'text-muted'}`}
                    >
                      {test.message}
                    </p>
                  ) : null}

                  {isConfirmingDelete && deleteError ? (
                    <p
                      role="alert"
                      data-testid={`webhook-delete-error-${endpoint.id}`}
                      className="text-sm font-ui text-danger"
                    >
                      {deleteError}
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
        title={t('webhooks.form.title')}
        closeLabel={t('common.close')}
      >
        <EndpointForm onCreated={onCreated} />
      </Sheet>

      <SecretOnceDialog
        open={newSecretResult !== null}
        onOpenChange={(open) => {
          if (!open) setNewSecretResult(null);
        }}
        secret={newSecretResult?.secret ?? ''}
      />
    </div>
  );
}

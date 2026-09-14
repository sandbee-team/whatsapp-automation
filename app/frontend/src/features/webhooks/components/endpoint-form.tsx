import * as React from 'react';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Button, Input, useT } from '@wp/ui';
import {
  createWebhookEndpointInputSchema,
  WEBHOOK_EVENT_TYPES,
  type WebhookEventType,
} from '@wp/contracts';
import { ApiError } from '../../../lib/api-client.js';
import { createWebhookEndpoint, type CreateWebhookEndpointResult } from '../api.js';

/**
 * EndpointForm (P15 U6, step 9) - creates one webhook endpoint
 * (`webhooksContract.create`). Honest copy only: states plainly that
 * delivery is at-least-once (never "instant"/"guaranteed"/"exactly once")
 * and that receivers must dedupe on `X-WP-Event-Id`; the in-app realtime
 * connection is described as a state hint, never a substitute event log -
 * both notices are always-visible text (`webhooks.form.deliveryNotice`,
 * `.sseHint`), never behind a tooltip or collapsed section, so a integrator
 * cannot miss them while wiring up their receiver.
 *
 * On success, hands the FULL result (including the once-only `secret`) to
 * `onCreated` - the caller (`endpoint-list.tsx`) is responsible for routing
 * it straight into `secret-once-dialog.tsx` and never persisting it.
 */
export interface EndpointFormProps {
  onCreated: (result: CreateWebhookEndpointResult) => void;
}

interface EndpointFormValues {
  url: string;
  events: WebhookEventType[];
}

export function EndpointForm({ onCreated }: EndpointFormProps): React.JSX.Element {
  const t = useT();
  const [submitError, setSubmitError] = React.useState<string | null>(null);
  const {
    control,
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<EndpointFormValues>({
    resolver: zodResolver(createWebhookEndpointInputSchema),
    defaultValues: { url: '', events: [] },
  });

  const onSubmit = handleSubmit(async (values) => {
    setSubmitError(null);
    try {
      const result = await createWebhookEndpoint(values);
      onCreated(result);
    } catch (error) {
      if (error instanceof ApiError) {
        setSubmitError(error.message);
      } else {
        setSubmitError(t('webhooks.form.genericError'));
      }
    }
  });

  return (
    <form
      data-testid="webhook-endpoint-form"
      onSubmit={(event) => void onSubmit(event)}
      noValidate
      className="flex flex-col gap-4"
    >
      <h2 className="text-lg font-semibold font-ui text-fg">{t('webhooks.form.title')}</h2>

      <Input
        label={t('webhooks.form.urlLabel')}
        description={t('webhooks.form.urlDescription')}
        placeholder={t('webhooks.form.urlPlaceholder')}
        data-testid="webhook-url-input"
        error={errors.url ? t('webhooks.form.urlRequired') : undefined}
        {...register('url')}
      />

      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium font-ui text-fg">
          {t('webhooks.form.eventsLabel')}
        </legend>
        <Controller
          control={control}
          name="events"
          render={({ field }) => (
            <div className="flex flex-col gap-1">
              {WEBHOOK_EVENT_TYPES.map((eventType) => {
                const checked = field.value.includes(eventType);
                const inputId = `webhook-event-${eventType}`;
                return (
                  <label
                    key={eventType}
                    htmlFor={inputId}
                    className="flex items-center gap-2 text-sm font-ui text-fg"
                  >
                    <input
                      id={inputId}
                      type="checkbox"
                      data-testid={inputId}
                      checked={checked}
                      onChange={(event) => {
                        field.onChange(
                          event.target.checked
                            ? [...field.value, eventType]
                            : field.value.filter((value) => value !== eventType),
                        );
                      }}
                    />
                    {eventType}
                  </label>
                );
              })}
            </div>
          )}
        />
        {errors.events ? (
          <p role="alert" className="text-sm font-ui text-danger">
            {t('webhooks.form.eventsRequired')}
          </p>
        ) : null}
      </fieldset>

      <p className="text-sm font-ui text-muted" data-testid="webhook-delivery-notice">
        {t('webhooks.form.deliveryNotice')}
      </p>
      <p className="text-sm font-ui text-muted" data-testid="webhook-sse-hint">
        {t('webhooks.form.sseHint')}
      </p>

      {submitError ? (
        <p role="alert" data-testid="webhook-form-error" className="text-sm font-ui text-danger">
          {submitError}
        </p>
      ) : null}

      <Button
        type="submit"
        data-testid="webhook-form-submit"
        loading={isSubmitting}
        loadingLabel={t('common.loading')}
      >
        {t('webhooks.form.submitButton')}
      </Button>
    </form>
  );
}

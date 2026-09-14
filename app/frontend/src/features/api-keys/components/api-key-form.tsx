import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Button, Input, useT } from '@wp/ui';
import { createApiKeyInputSchema } from '@wp/contracts';
import { ApiError } from '../../../lib/api-client.js';
import { createApiKey, type CreateApiKeyResult } from '../api.js';

/**
 * ApiKeyForm (go-live U5) - creates one API key (`apiKeysContract.create`),
 * a single `name` field (1..64 chars, enforced by the shared contract
 * schema). On success, hands the FULL result (including the once-only
 * `key`) to `onCreated` - the caller (`api-key-list.tsx`) is responsible for
 * routing it straight into `key-once-dialog.tsx` and never persisting it.
 * Modelled on `features/webhooks/components/endpoint-form.tsx`.
 */
export interface ApiKeyFormProps {
  onCreated: (result: CreateApiKeyResult) => void;
}

interface ApiKeyFormValues {
  name: string;
}

export function ApiKeyForm({ onCreated }: ApiKeyFormProps): React.JSX.Element {
  const t = useT();
  const [submitError, setSubmitError] = React.useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ApiKeyFormValues>({
    resolver: zodResolver(createApiKeyInputSchema),
    defaultValues: { name: '' },
  });

  const onSubmit = handleSubmit(async (values) => {
    setSubmitError(null);
    try {
      const result = await createApiKey(values);
      onCreated(result);
    } catch (error) {
      if (error instanceof ApiError) {
        setSubmitError(error.message);
      } else {
        setSubmitError(t('apiKeys.form.genericError'));
      }
    }
  });

  return (
    <form
      data-testid="api-key-form"
      onSubmit={(event) => void onSubmit(event)}
      noValidate
      className="flex flex-col gap-4"
    >
      <h2 className="text-lg font-semibold font-ui text-fg">{t('apiKeys.form.title')}</h2>

      <Input
        label={t('apiKeys.form.nameLabel')}
        description={t('apiKeys.form.nameDescription')}
        placeholder={t('apiKeys.form.namePlaceholder')}
        data-testid="api-key-name-input"
        error={errors.name ? t('apiKeys.form.nameRequired') : undefined}
        {...register('name')}
      />

      {submitError ? (
        <p role="alert" data-testid="api-key-form-error" className="text-sm font-ui text-danger">
          {submitError}
        </p>
      ) : null}

      <Button
        type="submit"
        data-testid="api-key-form-submit"
        loading={isSubmitting}
        loadingLabel={t('common.loading')}
      >
        {t('apiKeys.form.submitButton')}
      </Button>
    </form>
  );
}

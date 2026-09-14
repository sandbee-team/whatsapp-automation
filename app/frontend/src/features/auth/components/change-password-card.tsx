import * as React from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { passwordSchema } from '@wp/contracts';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  PasswordInput,
  useT,
  useToast,
} from '@wp/ui';
import { useForm } from 'react-hook-form';
import { ApiError } from '../../../lib/api-client.js';
import { changePassword } from '../api.js';

/**
 * ChangePasswordCard (P28 Unit U7, `/settings/security`) - the real
 * change-password form replacing the previous "not available yet" honest
 * placeholder. `PasswordInput` already owns its own label/error/description
 * slots (same shape as `Input`), so this form wires react-hook-form's
 * `register` straight onto it - the codebase's established pattern (see
 * `LoginForm`/`TotpVerifyPanel`), never `FormField` double-wrapping a
 * control that already renders its own `<label>`. Client-side `refine`
 * enforces the confirm-match; the server remains the source of truth for
 * the current-password check (a 401 surfaces inline on the current-password
 * field, never a generic toast - the same "server error maps to the right
 * field" idiom as `LoginForm`'s `UNAUTHENTICATED` handling).
 */
const changePasswordFormSchema = z
  .object({
    currentPassword: z.string().min(1),
    newPassword: passwordSchema,
    confirmPassword: z.string().min(1),
  })
  .refine((values) => values.newPassword === values.confirmPassword, {
    path: ['confirmPassword'],
    message: 'MISMATCH',
  });

type ChangePasswordFormValues = z.infer<typeof changePasswordFormSchema>;

export function ChangePasswordCard(): React.JSX.Element {
  const t = useT();
  const { showToast } = useToast();
  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isSubmitting, isValid },
  } = useForm<ChangePasswordFormValues>({
    resolver: zodResolver(changePasswordFormSchema),
    mode: 'onChange',
    defaultValues: { currentPassword: '', newPassword: '', confirmPassword: '' },
  });

  const onSubmit = handleSubmit(async (values) => {
    try {
      const result = await changePassword({
        currentPassword: values.currentPassword,
        newPassword: values.newPassword,
      });
      const description =
        result.otherSessionsRevoked > 0
          ? t('settings.security.password.otherSessionsRevoked')
          : undefined;
      showToast({
        title: t('settings.security.password.successToast'),
        description,
        tone: 'success',
      });
      reset();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setError('currentPassword', {
          type: 'server',
          message: t('settings.security.password.wrongCurrentPassword'),
        });
        return;
      }
      showToast({ title: t('settings.security.password.genericError'), tone: 'danger' });
    }
  });

  const confirmError =
    errors.confirmPassword?.message === 'MISMATCH'
      ? t('settings.security.password.confirmMismatch')
      : errors.confirmPassword?.message;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('settings.security.password.title')}</CardTitle>
      </CardHeader>
      <CardBody>
        <form onSubmit={(event) => void onSubmit(event)} noValidate className="flex flex-col gap-4">
          <PasswordInput
            label={t('settings.security.password.currentLabel')}
            data-testid="security-password-current"
            autoComplete="current-password"
            required
            showLabel={t('shell.auth.showPassword')}
            hideLabel={t('shell.auth.hidePassword')}
            error={errors.currentPassword?.message}
            {...register('currentPassword')}
          />

          <PasswordInput
            label={t('settings.security.password.newLabel')}
            description={t('settings.security.password.newDescription')}
            data-testid="security-password-new"
            autoComplete="new-password"
            required
            showLabel={t('shell.auth.showPassword')}
            hideLabel={t('shell.auth.hidePassword')}
            error={errors.newPassword?.message}
            {...register('newPassword')}
          />

          <PasswordInput
            label={t('settings.security.password.confirmLabel')}
            data-testid="security-password-confirm"
            autoComplete="new-password"
            required
            showLabel={t('shell.auth.showPassword')}
            hideLabel={t('shell.auth.hidePassword')}
            error={confirmError}
            {...register('confirmPassword')}
          />

          <Button
            type="submit"
            size="sm"
            className="w-fit"
            data-testid="security-password-submit"
            loading={isSubmitting}
            disabled={!isValid || isSubmitting}
          >
            {t('settings.security.password.submitButton')}
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}

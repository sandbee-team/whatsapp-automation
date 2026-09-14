import * as React from 'react';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button, Input, Select, type SelectOption } from '@wp/ui';
import { useT } from '@wp/ui';
import { ApiError } from '../../../lib/api-client.js';
import { createTopupRequest, type CreateTopupRequestResult } from '../api.js';
import { rupeesToPaise, InvalidRupeeAmountError } from '../money.js';

/**
 * TopupRequestForm (P19 Unit U5, step 7; P26b U5 restyle) - submits one
 * manual top-up request (`POST /v1/wallet/topup-requests`), UPI or bank
 * transfer. `amount` is a rupees TEXT field the user types; conversion to
 * paise goes through the ONE `rupeesToPaise` function (binding correction
 * #9) - never `parseFloat` inline here. A duplicate UTR surfaces as
 * `wallet.topup.duplicateError` when the API returns 409 CONFLICT (mirrors
 * `endpoint-form.tsx`'s `ApiError` handling shape).
 *
 * IDEMPOTENCY (queue-engineering skill; fixed in C2 hardening - the key was
 * previously re-minted on every submit, so a retry after a transient
 * network failure could double-create the request): ONE `Idempotency-Key`
 * per submission INTENT, minted once and reused on every retry of that same
 * intent (same idiom as `useComposer.ts#onSend`); it is only cleared once
 * the submission actually settles (success, or a definitively terminal
 * error) so the next, different submission mints its own key.
 */
export interface TopupRequestFormProps {
  onSubmitted: (result: CreateTopupRequestResult) => void;
}

const formValuesSchema = z.object({
  amount: z.string().trim().min(1),
  method: z.enum(['upi', 'bank_transfer']),
  utr: z.string().trim().min(1).max(255),
});

type FormValues = z.infer<typeof formValuesSchema>;

export function TopupRequestForm({ onSubmitted }: TopupRequestFormProps): React.JSX.Element {
  const t = useT();
  const [submitError, setSubmitError] = React.useState<string | null>(null);
  // Submission-scoped, retry-safe key storage - see this file's header.
  const idempotencyKeyRef = React.useRef<string | null>(null);
  const {
    register,
    control,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(formValuesSchema),
    defaultValues: { amount: '', method: 'upi', utr: '' },
  });

  const methodOptions: SelectOption[] = [
    { value: 'upi', label: t('wallet.topup.methodUpi') },
    { value: 'bank_transfer', label: t('wallet.topup.methodBankTransfer') },
  ];

  const onSubmit = handleSubmit(async (values) => {
    setSubmitError(null);
    idempotencyKeyRef.current ??= crypto.randomUUID();
    const idempotencyKey = idempotencyKeyRef.current;
    try {
      const amountMinor = rupeesToPaise(values.amount);
      const result = await createTopupRequest(
        { amountMinor, method: values.method, externalRef: values.utr },
        idempotencyKey,
      );
      idempotencyKeyRef.current = null;
      onSubmitted(result);
    } catch (error) {
      if (error instanceof InvalidRupeeAmountError) {
        // A validation failure never reached the network - it is not a
        // retry of the same intent, so the next submit mints a fresh key.
        idempotencyKeyRef.current = null;
        setSubmitError(t('wallet.topup.genericError'));
      } else if (error instanceof ApiError && error.code === 'CONFLICT') {
        idempotencyKeyRef.current = null;
        setSubmitError(t('wallet.topup.duplicateError'));
      } else if (error instanceof ApiError) {
        idempotencyKeyRef.current = null;
        setSubmitError(error.message);
      } else {
        // A transport-level failure (network down, etc.) is exactly the
        // retryable case: keep the key so the user's manual retry reuses it.
        setSubmitError(t('wallet.topup.genericError'));
      }
    }
  });

  return (
    <form
      data-testid="topup-request-form"
      onSubmit={(event) => void onSubmit(event)}
      noValidate
      className="flex flex-col gap-4"
    >
      <h2 className="text-lg font-semibold font-ui text-fg">{t('wallet.topup.formTitle')}</h2>

      <Input
        label={t('wallet.topup.amountLabel')}
        data-testid="topup-amount-input"
        error={errors.amount ? t('wallet.topup.genericError') : undefined}
        {...register('amount')}
      />

      <Controller
        control={control}
        name="method"
        render={({ field }) => (
          <Select
            label={t('wallet.topup.methodLabel')}
            placeholder={t('wallet.topup.methodLabel')}
            options={methodOptions}
            value={field.value}
            onValueChange={(value) => field.onChange(value)}
            error={errors.method ? t('wallet.topup.genericError') : undefined}
          />
        )}
      />

      <Input
        label={t('wallet.topup.utrLabel')}
        data-testid="topup-utr-input"
        error={errors.utr ? t('wallet.topup.genericError') : undefined}
        {...register('utr')}
      />

      {submitError ? (
        <p role="alert" data-testid="topup-form-error" className="text-sm font-ui text-danger">
          {submitError}
        </p>
      ) : null}

      <Button
        type="submit"
        data-testid="topup-form-submit"
        loading={isSubmitting}
        loadingLabel={t('common.loading')}
      >
        {t('wallet.topup.submitButton')}
      </Button>
    </form>
  );
}

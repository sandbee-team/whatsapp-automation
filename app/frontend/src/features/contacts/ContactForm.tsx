'use client';

import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button, Input, useT } from '@wp/ui';
import { ApiError } from '../../lib/api-client.js';
import { createContact, type ContactItem } from './api.js';

/**
 * ContactForm (P20 Unit U9, step 10) - creates one contact
 * (`contactsContract.create`). `defaultCountry` is prefilled from the
 * caller's best-known client country (falls back to `IN`) but stays a plain
 * 2-letter input the user can override, same shape as `EndpointForm`'s
 * ApiError handling. Uses its own local `formValuesSchema` (plain,
 * always-string fields with `defaultValues` for all of them) rather than
 * `createContactInputSchema` directly - that contract schema's fields are
 * `.optional()`, which does not match react-hook-form's controlled-string
 * inputs, same idiom as `TopupRequestForm`'s own local schema.
 *
 * `displayName`'s `.max(200)` mirrors `createContactInputSchema.displayName`
 * verbatim (bug fixed in C2 hardening - this local schema previously had no
 * max at all, so a huge label was accepted by the UI and only ever rejected
 * server-side, one round-trip later).
 */
export interface ContactFormProps {
  defaultCountry: string;
  onCreated: (contact: ContactItem) => void;
}

const formValuesSchema = z.object({
  phone: z.string().trim().min(1),
  defaultCountry: z.string().trim(),
  displayName: z.string().trim().max(200),
});

type ContactFormValues = z.infer<typeof formValuesSchema>;

export function ContactForm({ defaultCountry, onCreated }: ContactFormProps): React.JSX.Element {
  const t = useT();
  const [submitError, setSubmitError] = React.useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ContactFormValues>({
    resolver: zodResolver(formValuesSchema),
    defaultValues: { phone: '', defaultCountry, displayName: '' },
  });

  const onSubmit = handleSubmit(async (values) => {
    setSubmitError(null);
    try {
      const contact = await createContact({
        phone: values.phone,
        defaultCountry: values.defaultCountry || undefined,
        displayName: values.displayName || undefined,
      });
      onCreated(contact);
    } catch (error) {
      setSubmitError(error instanceof ApiError ? error.message : t('contacts.form.genericError'));
    }
  });

  return (
    <form
      data-testid="contact-form"
      onSubmit={(event) => void onSubmit(event)}
      noValidate
      className="flex flex-col gap-4"
    >
      <h2 className="text-lg font-semibold font-ui text-fg">{t('contacts.form.title')}</h2>

      <Input
        label={t('contacts.form.phoneLabel')}
        description={t('contacts.form.phoneDescription')}
        data-testid="contact-form-phone"
        error={errors.phone ? t('contacts.form.genericError') : undefined}
        {...register('phone')}
      />

      <Input
        label={t('contacts.form.countryLabel')}
        data-testid="contact-form-country"
        error={errors.defaultCountry ? t('contacts.form.genericError') : undefined}
        {...register('defaultCountry')}
      />

      <Input
        label={t('contacts.form.nameLabel')}
        data-testid="contact-form-name"
        error={errors.displayName ? t('contacts.form.genericError') : undefined}
        {...register('displayName')}
      />

      {submitError ? (
        <p role="alert" data-testid="contact-form-error" className="text-sm font-ui text-danger">
          {submitError}
        </p>
      ) : null}

      <Button
        type="submit"
        data-testid="contact-form-submit"
        loading={isSubmitting}
        loadingLabel={t('common.loading')}
      >
        {t('contacts.form.submitButton')}
      </Button>
    </form>
  );
}

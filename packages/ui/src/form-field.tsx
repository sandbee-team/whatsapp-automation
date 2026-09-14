import * as React from 'react';

/**
 * FormField - a react-hook-form AGNOSTIC wrapper: renders a label,
 * description and error around a render-prop `children`, and passes the
 * generated `id`/`aria-invalid`/`aria-describedby` to the control via the
 * render prop. The error text is a plain `<p>` with an id - deliberately NOT
 * `role="alert"` (an alert on every keystroke floods screen readers).
 * Purely presentational (no hooks of its own beyond `useId`, no DOM event
 * props), so no `'use client'` directive.
 */
export interface FormFieldRenderProps {
  id: string;
  'aria-invalid'?: true;
  'aria-describedby'?: string;
}

export interface FormFieldProps {
  label: string;
  description?: string;
  error?: string;
  required?: boolean;
  htmlFor?: string;
  children: (field: FormFieldRenderProps) => React.ReactNode;
}

export function FormField({
  label,
  description,
  error,
  required,
  htmlFor,
  children,
}: FormFieldProps): React.JSX.Element {
  const generatedId = React.useId();
  const fieldId = htmlFor ?? generatedId;
  const descriptionId = description ? `${fieldId}-description` : undefined;
  const errorId = error ? `${fieldId}-error` : undefined;
  const describedBy = [descriptionId, errorId].filter(Boolean).join(' ') || undefined;

  const field: FormFieldRenderProps = {
    id: fieldId,
    ...(error ? { 'aria-invalid': true as const } : {}),
    ...(describedBy ? { 'aria-describedby': describedBy } : {}),
  };

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={fieldId} className="text-sm font-medium font-ui text-fg">
        {label}
        {required ? (
          <span aria-hidden className="text-danger">
            {' '}
            *
          </span>
        ) : null}
      </label>
      {children(field)}
      {description ? (
        <p id={descriptionId} className="text-sm text-muted font-ui">
          {description}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="text-sm text-danger font-ui">
          {error}
        </p>
      ) : null}
    </div>
  );
}

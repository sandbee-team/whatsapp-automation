'use client';

import * as React from 'react';
import { cx } from './lib/cx.js';

/**
 * Textarea - same anatomy as Input (`label` required, `description`,
 * `error`, `aria-describedby`/`aria-invalid` wiring). `maxLength` + a caller-
 * supplied `counterLabel(count, max)` renders a live character counter (no
 * hard-coded copy in this package). `autoResize` is opt-in: it grows the
 * textarea to fit its content on every change. Carries `'use client'`:
 * forwards `onChange` and uses `useState`/`useRef` for auto-resize/counter.
 */
export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  label: string;
  description?: string;
  error?: string;
  /** Renders a live character counter under the textarea, e.g. `(c, m) => `${c}/${m}``. */
  counterLabel?: (count: number, max: number) => string;
  /** Grows the textarea to fit its content as the user types. */
  autoResize?: boolean;
}

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  {
    label,
    description,
    error,
    maxLength,
    counterLabel,
    autoResize = false,
    id,
    className,
    onChange,
    defaultValue,
    value,
    ...rest
  },
  ref,
) {
  const generatedId = React.useId();
  const textareaId = id ?? generatedId;
  const descriptionId = description ? `${textareaId}-description` : undefined;
  const errorId = error ? `${textareaId}-error` : undefined;
  const counterId = counterLabel && maxLength ? `${textareaId}-counter` : undefined;
  const describedBy = [descriptionId, errorId, counterId].filter(Boolean).join(' ') || undefined;

  const initial =
    typeof value === 'string' ? value : typeof defaultValue === 'string' ? defaultValue : '';
  const [count, setCount] = React.useState(initial.length);
  const localRef = React.useRef<HTMLTextAreaElement | null>(null);

  const resize = (element: HTMLTextAreaElement): void => {
    if (!autoResize) return;
    element.style.height = 'auto';
    element.style.height = `${String(element.scrollHeight)}px`;
  };

  const setRefs = (element: HTMLTextAreaElement | null): void => {
    localRef.current = element;
    if (typeof ref === 'function') ref(element);
    else if (ref) (ref as React.RefObject<HTMLTextAreaElement | null>).current = element;
  };

  React.useEffect(() => {
    if (localRef.current) resize(localRef.current);
  }, [autoResize]);

  const handleChange = (event: React.ChangeEvent<HTMLTextAreaElement>): void => {
    setCount(event.target.value.length);
    resize(event.target);
    onChange?.(event);
  };

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={textareaId} className="text-sm font-medium font-ui text-fg">
        {label}
      </label>
      <textarea
        ref={setRefs}
        id={textareaId}
        maxLength={maxLength}
        aria-invalid={Boolean(error) || undefined}
        aria-describedby={describedBy}
        value={value}
        defaultValue={defaultValue}
        onChange={handleChange}
        className={cx(
          'w-full rounded-md border border-border-strong bg-surface px-3 py-2 font-ui text-fg',
          'placeholder:text-subtle focus-visible:outline-none focus-visible:ring-2',
          'focus-visible:ring-ring focus-visible:ring-offset-2 ring-offset-bg',
          'disabled:opacity-50 disabled:pointer-events-none',
          error && 'border-danger',
          className,
        )}
        {...rest}
      />
      {counterLabel && maxLength ? (
        <p id={counterId} className="text-right text-xs text-muted font-ui">
          {counterLabel(count, maxLength)}
        </p>
      ) : null}
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
});

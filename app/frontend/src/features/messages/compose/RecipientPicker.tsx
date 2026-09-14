import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Input, useT } from '@wp/ui';
import { listContacts } from '../../contacts/api.js';

/**
 * RecipientPicker (P26b U4) - the composer's "To" field: a plain `Input`
 * (free typing of an E.164 number stays fully supported - `composer.test.tsx`
 * drives `compose-recipient-input` directly with `fireEvent.change`) plus a
 * debounced contacts typeahead (`GET /v1/contacts?search=`, read-only reuse of
 * `features/contacts/api.ts`) that only ever fills the SAME value on pick -
 * never a second source of truth for the recipient string.
 */
export interface RecipientPickerProps {
  value: string;
  onValueChange: (value: string) => void;
}

const SEARCH_MIN_LENGTH = 2;

export function RecipientPicker({ value, onValueChange }: RecipientPickerProps): React.JSX.Element {
  const t = useT();
  const [focused, setFocused] = React.useState(false);
  const searchTerm = value.trim();
  const searchEnabled =
    focused && searchTerm.length >= SEARCH_MIN_LENGTH && !searchTerm.startsWith('+');

  const contactsQuery = useQuery({
    queryKey: ['messages-compose-recipient-search', searchTerm],
    queryFn: () => listContacts({ q: searchTerm }, undefined),
    enabled: searchEnabled,
  });

  const suggestions = searchEnabled ? (contactsQuery.data?.items ?? []) : [];

  return (
    <div className="relative flex flex-col gap-1">
      <Input
        label={t('messages.compose.recipientLabel')}
        description={t('messages.compose.recipientDescription')}
        placeholder={t('messages.compose.recipientPlaceholder')}
        data-testid="compose-recipient-input"
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setTimeout(() => setFocused(false), 150)}
        aria-label={t('messages.compose.recipientPicker.searchLabel')}
      />
      {suggestions.length > 0 ? (
        <ul className="absolute top-full z-10 mt-1 w-full rounded-md border border-border bg-surface p-1 font-ui shadow-md">
          {suggestions.map((contact) => (
            <li key={contact.id}>
              <button
                type="button"
                className="flex w-full items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-fg hover:bg-surface-2"
                onClick={() => onValueChange(contact.phoneE164)}
              >
                <span>{contact.displayName ?? contact.phoneE164}</span>
                <span className="text-xs text-muted">{contact.phoneE164}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

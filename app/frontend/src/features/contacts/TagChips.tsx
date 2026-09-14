'use client';

import * as React from 'react';
import { Badge, Button, Input, useT } from '@wp/ui';
import type { ContactTagItem } from './api.js';

/**
 * TagChips (P20 Unit U9, step 10) - two modes on the SAME data shape:
 * `mode="filter"` (ContactsList header) toggles a tag on/off as a list
 * filter (single-select, since `listContacts` takes one `tagId`); `mode=
 * "edit"` (ContactDrawer) shows the contact's own tags with a remove action
 * plus an inline "create a new tag" field that both creates the tag AND
 * attaches it in one step. Purely a controlled-props component - no data
 * fetching of its own (the caller owns the tag list query).
 */
export interface TagChipsProps {
  mode: 'filter' | 'edit';
  tags: ContactTagItem[];
  selectedTagIds: string[];
  onToggle?: (tagId: string) => void;
  onRemove?: (tagId: string) => void;
  onCreateAndAttach?: (name: string) => void;
  creating?: boolean;
}

export function TagChips({
  mode,
  tags,
  selectedTagIds,
  onToggle,
  onRemove,
  onCreateAndAttach,
  creating = false,
}: TagChipsProps): React.JSX.Element {
  const t = useT();
  const [newTagName, setNewTagName] = React.useState('');

  const selected = tags.filter((tag) => selectedTagIds.includes(tag.id));
  const chips = mode === 'filter' ? tags : selected;

  return (
    <div data-testid="tag-chips" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {chips.map((tag) => {
          const isSelected = selectedTagIds.includes(tag.id);
          if (mode === 'filter') {
            return (
              <button
                key={tag.id}
                type="button"
                data-testid={`tag-chip-filter-${tag.id}`}
                onClick={() => onToggle?.(tag.id)}
                aria-pressed={isSelected}
              >
                <Badge tone={isSelected ? 'accent' : 'neutral'}>{tag.name}</Badge>
              </button>
            );
          }
          return (
            <span key={tag.id} className="inline-flex items-center gap-1">
              <Badge tone="neutral">{tag.name}</Badge>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                data-testid={`tag-chip-remove-${tag.id}`}
                onClick={() => onRemove?.(tag.id)}
              >
                {t('contacts.drawer.removeTagButton')}
              </Button>
            </span>
          );
        })}
      </div>

      {mode === 'edit' ? (
        <form
          data-testid="tag-chip-create-form"
          onSubmit={(event) => {
            event.preventDefault();
            const trimmed = newTagName.trim();
            if (trimmed.length === 0) return;
            onCreateAndAttach?.(trimmed);
            setNewTagName('');
          }}
          className="flex items-end gap-2"
        >
          <Input
            label={t('contacts.drawer.tagsTitle')}
            placeholder={t('contacts.drawer.addTagPlaceholder')}
            value={newTagName}
            data-testid="tag-chip-new-name"
            onChange={(event) => setNewTagName(event.target.value)}
          />
          <Button
            type="submit"
            variant="secondary"
            size="sm"
            data-testid="tag-chip-create-button"
            loading={creating}
            loadingLabel={t('common.loading')}
          >
            {t('contacts.drawer.addTagButton')}
          </Button>
        </form>
      ) : null}
    </div>
  );
}

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button, Input, useT } from '@wp/ui';
import { listContactTags, listContacts, contactsKeys } from '../../contacts/index.js';
import { useGroupList } from '../../groups/index.js';
import type { ComposerTargetKind } from './use-composer.js';

/**
 * AudiencePicker (P23a Unit U4; P24 groups-messaging Unit U5 added the
 * `groups` target kind) - tag checkboxes (from `listContactTags`) plus a
 * search-then-add contact picker (from `listContacts`) when `targetKind` is
 * `contacts`; a checklist of the selected instance's `send_enabled` groups
 * (from `useGroupList`, the SAME groups-panel list query - no second groups
 * fetcher is built here) when `targetKind` is `groups`. Rows whose
 * `eligibility.sendable` is `false` render disabled with their reason - a
 * user can never select a group the server will refuse. Pure controlled
 * component: the caller (`useComposer`) owns every piece of state, this
 * component only fetches the read-only lists it needs to render choices.
 */
export interface AudiencePickerProps {
  targetKind: ComposerTargetKind;
  instanceId: string;
  tagIds: string[];
  contactIds: string[];
  contactLabels: Record<string, string>;
  onToggleTag: (tagId: string) => void;
  onAddContact: (contactId: string, label: string) => void;
  onRemoveContact: (contactId: string) => void;
  groupIds: string[];
  onToggleGroup: (groupId: string) => void;
}

export function AudiencePicker({
  targetKind,
  instanceId,
  tagIds,
  contactIds,
  contactLabels,
  onToggleTag,
  onAddContact,
  onRemoveContact,
  groupIds,
  onToggleGroup,
}: AudiencePickerProps): React.JSX.Element {
  const t = useT();

  if (targetKind === 'groups') {
    return (
      <GroupsAudiencePicker
        instanceId={instanceId}
        groupIds={groupIds}
        onToggleGroup={onToggleGroup}
      />
    );
  }

  return (
    <ContactsAudiencePicker
      tagIds={tagIds}
      contactIds={contactIds}
      contactLabels={contactLabels}
      onToggleTag={onToggleTag}
      onAddContact={onAddContact}
      onRemoveContact={onRemoveContact}
      t={t}
    />
  );
}

interface GroupsAudiencePickerProps {
  instanceId: string;
  groupIds: string[];
  onToggleGroup: (groupId: string) => void;
}

function GroupsAudiencePicker({
  instanceId,
  groupIds,
  onToggleGroup,
}: GroupsAudiencePickerProps): React.JSX.Element {
  const t = useT();
  const query = useGroupList(instanceId);
  const groups = (query.data?.pages ?? [])
    .flatMap((page) => page.items)
    .filter((group) => group.sendEnabled);

  return (
    <div className="flex flex-col gap-3" data-testid="audience-groups-picker">
      <h3 className="text-lg font-semibold font-ui text-fg">
        {t('broadcasts.composer.audienceLabel')}
      </h3>
      <p className="text-sm font-ui text-muted">{t('groups.disclosure')}</p>
      <div className="flex flex-col gap-1">
        {groups.map((group) => (
          <label
            key={group.id}
            className="flex items-center gap-2 text-sm font-ui text-fg"
            data-testid={`audience-group-option-${group.id}`}
          >
            <input
              type="checkbox"
              checked={groupIds.includes(group.id)}
              disabled={!group.eligibility.sendable}
              onChange={() => onToggleGroup(group.id)}
            />
            {group.subject ?? t('groups.subject.fallback')}
            {!group.eligibility.sendable ? (
              <span className="text-sm font-ui text-muted">
                {t(`groups.reason.${group.eligibility.reason}` as Parameters<typeof t>[0])}
              </span>
            ) : null}
          </label>
        ))}
      </div>
      <p className="text-sm font-ui text-muted" data-testid="audience-groups-summary">
        {groupIds.length === 0
          ? t('broadcasts.composer.groupsAllEnabled')
          : t('broadcasts.composer.groupsSelectedCount', { count: groupIds.length })}
      </p>
    </div>
  );
}

interface ContactsAudiencePickerProps {
  tagIds: string[];
  contactIds: string[];
  contactLabels: Record<string, string>;
  onToggleTag: (tagId: string) => void;
  onAddContact: (contactId: string, label: string) => void;
  onRemoveContact: (contactId: string) => void;
  t: ReturnType<typeof useT>;
}

function ContactsAudiencePicker({
  tagIds,
  contactIds,
  contactLabels,
  onToggleTag,
  onAddContact,
  onRemoveContact,
  t,
}: ContactsAudiencePickerProps): React.JSX.Element {
  const [searchTerm, setSearchTerm] = React.useState('');
  const [submittedQuery, setSubmittedQuery] = React.useState('');

  const tagsQuery = useQuery({
    queryKey: contactsKeys.tags(),
    queryFn: () => listContactTags(),
  });

  const searchQuery = useQuery({
    queryKey: contactsKeys.list({ q: submittedQuery }),
    queryFn: () => listContacts({ q: submittedQuery }, undefined),
    enabled: submittedQuery.trim().length > 0,
  });

  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-lg font-semibold font-ui text-fg">
        {t('broadcasts.composer.audienceLabel')}
      </h3>

      <div className="flex flex-col gap-1">
        <span className="text-sm font-medium font-ui text-fg">
          {t('broadcasts.composer.tagsLabel')}
        </span>
        <div className="flex flex-col gap-1">
          {(tagsQuery.data ?? []).map((tag) => (
            <label key={tag.id} className="flex items-center gap-2 text-sm font-ui text-fg">
              <input
                type="checkbox"
                checked={tagIds.includes(tag.id)}
                onChange={() => onToggleTag(tag.id)}
              />
              {tag.name} ({tag.contactCount})
            </label>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-end gap-2">
          <Input
            label={t('broadcasts.composer.contactSearchLabel')}
            placeholder={t('broadcasts.composer.contactSearchPlaceholder')}
            data-testid="audience-contact-search"
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
          />
          <Button type="button" variant="secondary" onClick={() => setSubmittedQuery(searchTerm)}>
            {t('broadcasts.composer.search')}
          </Button>
        </div>
        <div className="flex flex-col gap-1">
          {(searchQuery.data?.items ?? []).map((contact) => (
            <Button
              key={contact.id}
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onAddContact(contact.id, contact.displayName ?? contact.phoneE164)}
            >
              {contact.displayName ?? contact.phoneE164}
            </Button>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {contactIds.map((contactId) => (
          <span
            key={contactId}
            data-testid="audience-contact-chip"
            className="inline-flex items-center gap-1 rounded-full border border-border bg-surface px-3 py-1 text-sm font-ui text-fg"
          >
            {contactLabels[contactId] ?? contactId}
            <button
              type="button"
              aria-label={t('broadcasts.composer.remove')}
              onClick={() => onRemoveContact(contactId)}
            >
              ×
            </button>
          </span>
        ))}
      </div>

      <p className="text-sm font-ui text-muted" data-testid="audience-summary">
        {t('broadcasts.composer.audienceSummary', {
          tags: tagIds.length,
          contacts: contactIds.length,
        })}
      </p>
    </div>
  );
}

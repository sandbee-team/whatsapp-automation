'use client';

import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Input, Sheet, Spinner, useT } from '@wp/ui';
import { CONTACTS_COPY } from '@wp/domain';
import { ApiError } from '../../lib/api-client.js';
import {
  eraseContact,
  listContactTags,
  setContactTags,
  updateContact,
  createContactTag,
  type ContactItem,
} from './api.js';
import { contactsKeys, type ContactsListFilters } from './keys.js';
import { TagChips } from './TagChips.js';

/**
 * ContactDrawer (P20 Unit U9, step 10) - opened by clicking a contacts-list
 * row. Phone is read-only (identity, never updatable - `updateContactInput
 * Schema` carries no `phone` field); name is editable via PATCH. Tags use
 * `TagChips` in edit mode (add/remove + inline create-and-attach). Erasure is
 * gated behind an inline two-step confirm that always shows
 * `CONTACTS_COPY.erasureNote` - never a single click.
 */
export interface ContactDrawerProps {
  contact: ContactItem | null;
  onClose: () => void;
  onErased: () => void;
  listFilters: ContactsListFilters;
}

export function ContactDrawer({
  contact,
  onClose,
  onErased,
  listFilters,
}: ContactDrawerProps): React.JSX.Element {
  const t = useT();
  const queryClient = useQueryClient();
  const [displayName, setDisplayName] = React.useState(contact?.displayName ?? '');
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [saveMessage, setSaveMessage] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [confirmingErase, setConfirmingErase] = React.useState(false);
  const [eraseError, setEraseError] = React.useState<string | null>(null);
  const [erasing, setErasing] = React.useState(false);
  const [creatingTag, setCreatingTag] = React.useState(false);

  const { data: tags } = useQuery({
    queryKey: contactsKeys.tags(),
    queryFn: listContactTags,
    enabled: contact !== null,
  });

  React.useEffect(() => {
    setDisplayName(contact?.displayName ?? '');
    setSaveError(null);
    setSaveMessage(null);
    setConfirmingErase(false);
    setEraseError(null);
  }, [contact?.id]);

  const invalidateContact = (): void => {
    void queryClient.invalidateQueries({ queryKey: contactsKeys.list(listFilters) });
    if (contact) {
      void queryClient.invalidateQueries({ queryKey: contactsKeys.detail(contact.id) });
    }
  };

  const onSave = async (): Promise<void> => {
    if (!contact) return;
    setSaving(true);
    setSaveError(null);
    setSaveMessage(null);
    try {
      await updateContact(contact.id, { displayName: displayName || null });
      setSaveMessage(t('contacts.drawer.savedMessage'));
      invalidateContact();
    } catch (error) {
      setSaveError(error instanceof ApiError ? error.message : t('contacts.form.genericError'));
    } finally {
      setSaving(false);
    }
  };

  const onToggleRemoveTag = async (tagId: string): Promise<void> => {
    if (!contact) return;
    await setContactTags(contact.id, { remove: [tagId] });
    invalidateContact();
  };

  const onCreateAndAttachTag = async (name: string): Promise<void> => {
    if (!contact) return;
    setCreatingTag(true);
    try {
      const tag = await createContactTag({ name });
      await setContactTags(contact.id, { add: [tag.id] });
      void queryClient.invalidateQueries({ queryKey: contactsKeys.tags() });
      invalidateContact();
    } finally {
      setCreatingTag(false);
    }
  };

  const onErase = async (): Promise<void> => {
    if (!contact) return;
    setErasing(true);
    setEraseError(null);
    try {
      await eraseContact(contact.id);
      onErased();
    } catch (error) {
      setEraseError(error instanceof ApiError ? error.message : t('contacts.drawer.eraseError'));
    } finally {
      setErasing(false);
    }
  };

  const attrsEntries = contact ? Object.entries(contact.attrs) : [];

  return (
    <Sheet
      open={contact !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t('contacts.drawer.title')}
      closeLabel={t('common.close')}
    >
      {contact ? (
        <div data-testid="contact-drawer" className="flex flex-col gap-6">
          <Input
            label={t('contacts.drawer.phoneLabel')}
            value={contact.phoneE164}
            readOnly
            data-testid="contact-drawer-phone"
          />

          <Input
            label={t('contacts.drawer.nameLabel')}
            value={displayName}
            data-testid="contact-drawer-name"
            onChange={(event) => setDisplayName(event.target.value)}
          />

          {saveError ? (
            <p role="alert" data-testid="contact-drawer-save-error" className="text-sm text-danger">
              {saveError}
            </p>
          ) : null}
          {saveMessage ? (
            <p
              role="status"
              data-testid="contact-drawer-save-message"
              className="text-sm text-muted"
            >
              {saveMessage}
            </p>
          ) : null}

          <Button
            type="button"
            data-testid="contact-drawer-save"
            loading={saving}
            loadingLabel={t('common.loading')}
            onClick={() => void onSave()}
          >
            {t('contacts.drawer.saveButton')}
          </Button>

          <section>
            <h3 className="text-sm font-semibold font-ui text-fg">
              {t('contacts.drawer.attrsTitle')}
            </h3>
            {attrsEntries.length === 0 ? (
              <p className="text-sm font-ui text-muted">{t('contacts.drawer.attrsEmpty')}</p>
            ) : (
              <ul className="flex flex-col gap-1 text-sm font-ui text-fg">
                {attrsEntries.map(([key, value]) => (
                  <li key={key}>
                    {key}: {String(value)}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <h3 className="text-sm font-semibold font-ui text-fg">
              {t('contacts.drawer.tagsTitle')}
            </h3>
            <TagChips
              mode="edit"
              tags={tags ?? []}
              selectedTagIds={contact.tags.map((tag) => tag.id)}
              onRemove={(tagId) => void onToggleRemoveTag(tagId)}
              onCreateAndAttach={(name) => void onCreateAndAttachTag(name)}
              creating={creatingTag}
            />
          </section>

          <section>
            <h3 className="text-sm font-semibold font-ui text-fg">
              {t('contacts.drawer.optOutTitle')}
            </h3>
            {contact.optOutState === 'opted_out' ? (
              <Badge tone="warning" data-testid="contact-drawer-optout-badge">
                {t('contacts.drawer.optedOutSince', { date: contact.optedOutAt ?? '' })}
              </Badge>
            ) : (
              <Badge tone="neutral">{t('contacts.drawer.notOptedOut')}</Badge>
            )}
          </section>

          <section className="flex flex-col gap-2">
            {!confirmingErase ? (
              <Button
                type="button"
                variant="danger"
                size="sm"
                data-testid="contact-drawer-erase-button"
                onClick={() => setConfirmingErase(true)}
              >
                {t('contacts.drawer.eraseButton')}
              </Button>
            ) : (
              <div data-testid="contact-drawer-erase-confirm" className="flex flex-col gap-2">
                <p className="text-sm font-ui text-fg">{CONTACTS_COPY.erasureNote}</p>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="danger"
                    size="sm"
                    data-testid="contact-drawer-erase-confirm-button"
                    loading={erasing}
                    loadingLabel={t('common.loading')}
                    onClick={() => void onErase()}
                  >
                    {t('contacts.drawer.eraseConfirmButton')}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    data-testid="contact-drawer-erase-cancel-button"
                    onClick={() => setConfirmingErase(false)}
                  >
                    {t('contacts.drawer.eraseCancelButton')}
                  </Button>
                </div>
                {eraseError ? (
                  <p role="alert" className="text-sm text-danger">
                    {eraseError}
                  </p>
                ) : null}
              </div>
            )}
          </section>
        </div>
      ) : (
        <Spinner aria-label={t('common.loading')} />
      )}
    </Sheet>
  );
}

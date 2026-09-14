'use client';

import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { Search, Users } from 'lucide-react';
import {
  Avatar,
  Badge,
  Button,
  DataTable,
  EmptyState,
  ErrorState,
  Input,
  Select,
  Sheet,
  useT,
  type SelectOption,
} from '@wp/ui';
import { PageHeader } from '../../components/page-header.js';
import { listContacts, listContactTags, type ContactItem } from './api.js';
import { contactsKeys, type ContactsListFilters } from './keys.js';
import { TagChips } from './TagChips.js';
import { ContactForm } from './ContactForm.js';
import { ContactDrawer } from './ContactDrawer.js';
import { ContactsExportAction } from './ContactsExportAction.js';
import { ImportWizard } from './ImportWizard.js';

const SEARCH_DEBOUNCE_MS = 300;

/**
 * ContactsList (P20 Unit U9, step 10; P26b U5 restyle) - the `/contacts`
 * screen: `PageHeader` with add/import/export actions, a search+opt-out-
 * filter+tag-chips toolbar, a keyset-paginated `DataTable` (never page
 * numbers - "Load more" driven by `meta.nextCursor`), and the contact
 * drawer opened by a row click. Honest loading/empty/error states; every
 * `data-testid` preserved from the pre-restyle version.
 */
export function ContactsList(): React.JSX.Element {
  const t = useT();
  const queryClient = useQueryClient();

  const [searchInput, setSearchInput] = React.useState('');
  const [debouncedQuery, setDebouncedQuery] = React.useState('');
  const [optOutState, setOptOutState] = React.useState<'all' | 'none' | 'opted_out'>('all');
  const [selectedTagIds, setSelectedTagIds] = React.useState<string[]>([]);
  const [pages, setPages] = React.useState<ContactItem[][]>([]);
  const [cursor, setCursor] = React.useState<string | undefined>(undefined);
  const [nextCursor, setNextCursor] = React.useState<string | undefined>(undefined);
  const [addOpen, setAddOpen] = React.useState(false);
  const [importOpen, setImportOpen] = React.useState(false);
  const [selectedContactId, setSelectedContactId] = React.useState<string | null>(null);

  React.useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(searchInput.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const filters: ContactsListFilters = {
    q: debouncedQuery || undefined,
    tagId: selectedTagIds[0],
    optOutState: optOutState === 'all' ? undefined : optOutState,
  };
  const filterKey = JSON.stringify(filters);

  React.useEffect(() => {
    setPages([]);
    setCursor(undefined);
    setNextCursor(undefined);
  }, [filterKey]);

  const { data, isLoading, isError, isFetching, refetch } = useQuery({
    queryKey: [...contactsKeys.list(filters), cursor],
    queryFn: () => listContacts(filters, cursor),
  });

  React.useEffect(() => {
    if (!data) return;
    setPages((prev) => (cursor === undefined ? [data.items] : [...prev, data.items]));
    setNextCursor(data.nextCursor);
  }, [data, cursor]);

  const { data: tags } = useQuery({ queryKey: contactsKeys.tags(), queryFn: listContactTags });

  const contacts = pages.flat();
  const selectedContact = contacts.find((contact) => contact.id === selectedContactId) ?? null;

  const invalidateList = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['contacts', 'list'] });
    setPages([]);
    setCursor(undefined);
  };

  const optOutOptions: SelectOption[] = [
    { value: 'all', label: t('contacts.filter.optOutAll') },
    { value: 'opted_out', label: t('contacts.filter.optOutOptedOut') },
    { value: 'none', label: t('contacts.filter.optOutNotOptedOut') },
  ];

  const columns: ColumnDef<ContactItem, unknown>[] = [
    {
      id: 'name',
      header: t('contacts.table.name'),
      cell: ({ row }) => (
        <div className="flex items-center gap-2">
          <Avatar name={row.original.displayName ?? row.original.phoneE164} size="sm" />
          <span>{row.original.displayName ?? '—'}</span>
        </div>
      ),
    },
    {
      id: 'phone',
      header: t('contacts.table.phone'),
      cell: ({ row }) => <span className="font-mono text-sm">{row.original.phoneE164}</span>,
    },
    {
      id: 'tags',
      header: t('contacts.table.tags'),
      cell: ({ row }) => (
        <div className="flex flex-wrap gap-1">
          {row.original.tags.map((tag) => (
            <Badge key={tag.id} tone="neutral" size="sm">
              {tag.name}
            </Badge>
          ))}
        </div>
      ),
      meta: { priority: 'medium' },
    },
    {
      id: 'status',
      header: t('contacts.table.status'),
      cell: ({ row }) =>
        row.original.optOutState === 'opted_out' ? (
          <Badge tone="warning">{t('contacts.table.optedOutBadge')}</Badge>
        ) : null,
    },
    {
      id: 'updatedAt',
      header: t('contacts.table.updatedAt'),
      cell: ({ row }) => row.original.updatedAt,
      meta: { priority: 'low' },
    },
  ];

  return (
    <div data-testid="contacts-screen" className="flex flex-col gap-6">
      <PageHeader
        title={t('contacts.title')}
        description={t('contacts.subtitle')}
        actions={
          <>
            <Button
              type="button"
              data-testid="contacts-add-button"
              onClick={() => setAddOpen(true)}
            >
              {t('contacts.addButton')}
            </Button>
            <Button
              type="button"
              variant="secondary"
              data-testid="contacts-import-button"
              onClick={() => setImportOpen(true)}
            >
              {t('contacts.importButton')}
            </Button>
            <ContactsExportAction />
          </>
        }
      />

      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="flex-1">
            <Input
              label={t('contacts.searchLabel')}
              placeholder={t('contacts.searchPlaceholder')}
              data-testid="contacts-search-input"
              leadingIcon={<Search size={16} />}
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
            />
          </div>
          <div className="sm:w-56">
            <Select
              label={t('contacts.table.status')}
              placeholder={t('contacts.filter.optOutAll')}
              data-testid="contacts-optout-filter"
              options={optOutOptions}
              value={optOutState}
              onValueChange={(value) => setOptOutState(value as typeof optOutState)}
            />
          </div>
        </div>

        <TagChips
          mode="filter"
          tags={tags ?? []}
          selectedTagIds={selectedTagIds}
          onToggle={(tagId) => setSelectedTagIds((prev) => (prev.includes(tagId) ? [] : [tagId]))}
        />
      </div>

      {isLoading ? <p data-testid="contacts-loading" className="sr-only" /> : null}
      {isError ? <p data-testid="contacts-error" className="sr-only" /> : null}

      <DataTable
        caption={t('contacts.title')}
        columns={columns}
        data={contacts}
        isLoading={isLoading}
        getRowId={(row) => row.id}
        onRowClick={(row) => setSelectedContactId(row.id)}
        emptyState={
          <EmptyState
            icon={<Users aria-hidden size={20} />}
            title={t('contacts.empty.title')}
            body={t('contacts.empty.body')}
          />
        }
        errorState={
          isError ? (
            <ErrorState
              title={t('contacts.error')}
              retryAction={
                <Button type="button" variant="secondary" size="sm" onClick={() => void refetch()}>
                  {t('common.retry')}
                </Button>
              }
            />
          ) : undefined
        }
      />

      {!isLoading && !isError && nextCursor ? (
        <div className="flex justify-center">
          <Button
            type="button"
            variant="secondary"
            data-testid="contacts-load-more"
            loading={isFetching}
            loadingLabel={t('common.loading')}
            onClick={() => setCursor(nextCursor)}
          >
            {t('contacts.loadMore')}
          </Button>
        </div>
      ) : null}

      <Sheet
        open={addOpen}
        onOpenChange={setAddOpen}
        title={t('contacts.form.title')}
        closeLabel={t('common.close')}
      >
        <ContactForm
          defaultCountry="IN"
          onCreated={() => {
            setAddOpen(false);
            invalidateList();
          }}
        />
      </Sheet>

      <ImportWizard
        open={importOpen}
        onOpenChange={setImportOpen}
        onCompleted={() => invalidateList()}
      />

      <ContactDrawer
        contact={selectedContact}
        listFilters={filters}
        onClose={() => setSelectedContactId(null)}
        onErased={() => {
          setSelectedContactId(null);
          invalidateList();
        }}
      />
    </div>
  );
}

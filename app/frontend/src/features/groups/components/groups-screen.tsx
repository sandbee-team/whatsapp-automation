import * as React from 'react';
import { Users } from 'lucide-react';
import { EmptyState, Select, useT, type SelectOption } from '@wp/ui';
import { PageHeader } from '../../../components/page-header.js';
import { useInstanceList } from '../../instances/use-instance-list.js';
import { GroupList } from './group-list.js';

/**
 * GroupsScreen (P24 groups-messaging, Unit U5; P26b U5 restyle) - the
 * `/groups` route's top-level component: `PageHeader` + an instance picker
 * fed by `useInstanceList()` (THE one shared instance list - see that
 * hook's own doc comment; replaces the earlier `useInstanceOptions()`
 * one-off), rendering nothing below the picker until an instance is
 * selected (`groups.list.empty` covers the "no instance chosen yet" empty
 * state, same idiom as the composer's own instance-gated audience picker).
 */
export function GroupsScreen(): React.JSX.Element {
  const t = useT();
  const [instanceId, setInstanceId] = React.useState('');
  const instanceList = useInstanceList();

  const options: SelectOption[] = instanceList.items.map((item) => ({
    value: item.instanceId,
    label: item.card?.label ?? item.instanceId,
  }));

  return (
    <div data-testid="groups-route-screen" className="flex flex-col gap-6">
      <PageHeader title={t('groups.title')} description={t('groups.subtitle')} />

      <div data-testid="groups-instance-picker" className="sm:max-w-xs">
        <Select
          label={t('groups.instancePicker.label')}
          placeholder={t('groups.instancePicker.placeholder')}
          options={options}
          value={instanceId || null}
          onValueChange={(value) => setInstanceId(value)}
        />
      </div>

      {instanceId ? (
        <GroupList instanceId={instanceId} />
      ) : (
        <EmptyState
          data-testid="groups-no-instance"
          icon={<Users aria-hidden size={20} />}
          title={t('groups.title')}
          body={t('groups.list.empty')}
        />
      )}
    </div>
  );
}

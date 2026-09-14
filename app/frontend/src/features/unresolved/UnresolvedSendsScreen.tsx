import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { Card, CardBody, EmptyState, Input, useT } from '@wp/ui';
import { PageHeader } from '../../components/page-header.js';
import { UnresolvedSendsPanel } from './UnresolvedSendsPanel.js';

/**
 * UnresolvedSendsScreen (P12 U6a; P26b U4 restyle) - the `/unresolved`
 * route's component. There is no list route for unresolved sends across
 * every number at once (`api.ts`'s NO LIST ROUTE doc) so this screen never
 * fakes one: an informative card explains where these sends come from
 * (notifications of kind blocked/needs review) and links to the dashboard
 * activity feed, then the per-instance panel below only renders once a
 * number is entered - and, honestly, renders `EmptyState` (never a
 * spinner-forever) before that.
 */
export function UnresolvedSendsScreen(): React.JSX.Element {
  const t = useT();
  const [instanceId, setInstanceId] = React.useState('');

  return (
    <div data-testid="unresolved-sends-screen" className="flex flex-col gap-6">
      <PageHeader title={t('unresolved.panel.title')} />

      <Card>
        <CardBody className="flex flex-col gap-2">
          <h2 className="text-base font-semibold font-ui text-fg">
            {t('unresolved.explainer.title')}
          </h2>
          <p className="text-sm font-ui text-muted">{t('unresolved.explainer.body')}</p>
          <Link to="/" className="text-sm font-ui text-accent hover:underline">
            {t('unresolved.explainer.dashboardLink')}
          </Link>
        </CardBody>
      </Card>

      <Input
        label={t('unresolved.accountPicker.label')}
        description={t('messages.compose.accountDescription')}
        placeholder={t('unresolved.accountPicker.placeholder')}
        data-testid="unresolved-account-input"
        value={instanceId}
        onChange={(event) => setInstanceId(event.target.value)}
      />

      {instanceId.trim().length > 0 ? (
        <UnresolvedSendsPanel instanceId={instanceId.trim()} />
      ) : (
        <EmptyState
          title={t('unresolved.unavailable.title')}
          body={t('unresolved.unavailable.body')}
        />
      )}
    </div>
  );
}

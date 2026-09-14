import * as React from 'react';
import { Table, THead, TBody, TR, TH, TD, useT } from '@wp/ui';
import type { AdminClientDetail } from '../api.js';

/**
 * audit-tab.tsx (P28 Unit U6, step 9) - client-detail Audit tab: the
 * `recentStaffActions` already projected on the client-detail response.
 */
export interface AuditTabProps {
  client: AdminClientDetail;
}

export function AuditTab({ client }: AuditTabProps): React.JSX.Element {
  const t = useT();
  return (
    <Table caption={t('admin.clientDetail.tab.audit')}>
      <THead>
        <TR>
          <TH>{t('admin.audit.table.time')}</TH>
          <TH>{t('admin.audit.table.action')}</TH>
          <TH>{t('admin.audit.table.target')}</TH>
          <TH>{t('admin.audit.table.reason')}</TH>
        </TR>
      </THead>
      <TBody>
        {client.recentStaffActions.map((entry) => (
          <TR key={entry.id}>
            <TD>{new Date(entry.createdAt).toLocaleString()}</TD>
            <TD>{entry.action}</TD>
            <TD>{entry.targetRef ?? '—'}</TD>
            <TD>{entry.reason}</TD>
          </TR>
        ))}
      </TBody>
    </Table>
  );
}

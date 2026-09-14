import * as React from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { DataTable } from '../../src/data-table.js';
import { TableContainer, Table, THead, TBody, TR, TH, TD } from '../../src/table.js';
import { Pagination } from '../../src/pagination.js';
import { Stepper } from '../../src/stepper.js';
import { OtpInput } from '../../src/otp-input.js';
import { PhoneInput } from '../../src/phone-input.js';
import { QrDisplay } from '../../src/qr-display.js';
import { DateTimePicker } from '../../src/date-time-picker.js';
import type { Fixture } from './types.js';

interface FixtureRow {
  id: string;
  number: string;
  status: string;
}

const FIXTURE_ROWS: FixtureRow[] = [{ id: '1', number: '+91 90000 00000', status: 'Live' }];

const FIXTURE_COLUMNS: ColumnDef<FixtureRow, unknown>[] = [
  { accessorKey: 'number', header: 'Number', enableSorting: true },
  { accessorKey: 'status', header: 'Status' },
];

function OtpInputFixture(): React.JSX.Element {
  const [value, setValue] = React.useState('');
  return <OtpInput length={6} value={value} onValueChange={setValue} label="Verification code" />;
}

function PhoneInputFixture(): React.JSX.Element {
  const [value, setValue] = React.useState('+919000000000');
  return (
    <PhoneInput
      label="Phone number"
      value={value}
      onValueChange={setValue}
      countryLabel="Country"
    />
  );
}

function DateTimePickerFixture(): React.JSX.Element {
  const [value, setValue] = React.useState<string | null>('2026-09-07T10:30:00.000Z');
  return (
    <DateTimePicker label="Send at" value={value} onValueChange={setValue} clearLabel="Clear" />
  );
}

/** Axe fixtures for the data primitives (P26b U1c-2 data primitives (data-table, pagination, stepper, otp, phone, qr, date-time)). */
export const dataFixtures: readonly Fixture[] = [
  {
    name: 'Table (data unit)',
    render: () => (
      <TableContainer>
        <Table caption="Connected numbers">
          <THead>
            <TR>
              <TH>Number</TH>
              <TH>Status</TH>
            </TR>
          </THead>
          <TBody>
            <TR>
              <TD>+91 90000 00000</TD>
              <TD>Live</TD>
            </TR>
          </TBody>
        </Table>
      </TableContainer>
    ),
  },
  {
    name: 'DataTable',
    render: () => (
      <DataTable columns={FIXTURE_COLUMNS} data={FIXTURE_ROWS} caption="Connected numbers" />
    ),
  },
  {
    name: 'Pagination',
    render: () => (
      <Pagination
        page={2}
        pageCount={5}
        onPageChange={() => {}}
        labels={{ previous: 'Previous', next: 'Next', page: (n) => `Page ${n}` }}
      />
    ),
  },
  {
    name: 'Stepper',
    render: () => (
      <Stepper
        steps={[
          { id: 'connect', label: 'Connect number' },
          { id: 'verify', label: 'Verify' },
        ]}
        current={0}
        orientation="horizontal"
        completedLabel="Completed"
        currentLabel="Current"
        upcomingLabel="Upcoming"
      />
    ),
  },
  { name: 'OtpInput', render: () => <OtpInputFixture /> },
  { name: 'PhoneInput', render: () => <PhoneInputFixture /> },
  {
    name: 'QrDisplay',
    render: () => (
      <QrDisplay src="data:image/png;base64,AAAA" label="Scan to link WhatsApp" size={160} />
    ),
  },
  { name: 'DateTimePicker', render: () => <DateTimePickerFixture /> },
];

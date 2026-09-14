'use client';

import * as React from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { DataTable } from '../data-table.js';
import { TableContainer, Table, THead, TBody, TR, TH, TD } from '../table.js';
import { Pagination } from '../pagination.js';
import { Stepper } from '../stepper.js';
import { OtpInput } from '../otp-input.js';
import { PhoneInput } from '../phone-input.js';
import { QrDisplay } from '../qr-display.js';
import { DateTimePicker } from '../date-time-picker.js';
import type { UiExample } from './types.js';

interface GalleryNumberRow {
  id: string;
  number: string;
  status: string;
}

const GALLERY_ROWS: GalleryNumberRow[] = [
  { id: '1', number: '+91 90000 00000', status: 'Live' },
  { id: '2', number: '+91 90000 00001', status: 'Paused' },
];

const GALLERY_COLUMNS: ColumnDef<GalleryNumberRow, unknown>[] = [
  { accessorKey: 'number', header: 'Number', enableSorting: true },
  { accessorKey: 'status', header: 'Status', meta: { priority: 'medium' } },
];

function OtpInputExample(): React.JSX.Element {
  const [value, setValue] = React.useState('');
  return <OtpInput length={6} value={value} onValueChange={setValue} label="Verification code" />;
}

function PhoneInputExample(): React.JSX.Element {
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

function DateTimePickerExample(): React.JSX.Element {
  const [value, setValue] = React.useState<string | null>('2026-09-07T10:30:00.000Z');
  return (
    <DateTimePicker
      label="Send at"
      value={value}
      onValueChange={setValue}
      clearLabel="Clear"
      timezoneLabel="IST"
    />
  );
}

/** Builds a small black/white checkerboard SVG (no external asset, no colour literal) for the gallery's QrDisplay card. */
function buildQrPlaceholderSvg(): string {
  const cell = 8;
  const cellsPerSide = 10;
  const side = cell * cellsPerSide;
  const rects: string[] = [];
  for (let row = 0; row < cellsPerSide; row += 1) {
    for (let col = 0; col < cellsPerSide; col += 1) {
      const isDark = (row + col) % 2 === 0;
      rects.push(
        `<rect x="${String(col * cell)}" y="${String(row * cell)}" width="${String(cell)}" height="${String(cell)}" fill="${isDark ? 'black' : 'white'}" />`,
      );
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${String(side)} ${String(side)}">${rects.join('')}</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

const QR_PLACEHOLDER_SRC = buildQrPlaceholderSvg();

/** Gallery cards for the data primitives (P26b U1c-2 data primitives (data-table, pagination, stepper, otp, phone, qr, date-time)). */
export const dataExamples: readonly UiExample[] = [
  {
    name: 'Table',
    group: 'Data',
    render: () => (
      <TableContainer>
        <Table caption="Connected numbers" zebra>
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
            <TR>
              <TD>+91 90000 00001</TD>
              <TD>Paused</TD>
            </TR>
          </TBody>
        </Table>
      </TableContainer>
    ),
  },
  {
    name: 'DataTable',
    group: 'Data',
    render: () => (
      <DataTable columns={GALLERY_COLUMNS} data={GALLERY_ROWS} caption="Connected numbers" />
    ),
  },
  {
    name: 'Pagination',
    group: 'Data',
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
    group: 'Data',
    render: () => (
      <Stepper
        steps={[
          { id: 'connect', label: 'Connect number' },
          { id: 'verify', label: 'Verify' },
          { id: 'send', label: 'Send test message' },
        ]}
        current={1}
        orientation="horizontal"
        completedLabel="Completed"
        currentLabel="Current"
        upcomingLabel="Upcoming"
      />
    ),
  },
  { name: 'OtpInput', group: 'Data', render: () => <OtpInputExample /> },
  { name: 'PhoneInput', group: 'Data', render: () => <PhoneInputExample /> },
  {
    name: 'QrDisplay',
    group: 'Data',
    render: () => <QrDisplay src={QR_PLACEHOLDER_SRC} label="Scan to link WhatsApp" size={160} />,
  },
  { name: 'DateTimePicker', group: 'Data', render: () => <DateTimePickerExample /> },
];

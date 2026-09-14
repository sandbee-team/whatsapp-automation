// @vitest-environment jsdom
import * as React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { I18nProvider } from '@wp/ui';
import { MappingStep, type AttrMappingRow } from '../ImportWizardSteps.js';
import type { UploadImportResult } from '../api.js';

/**
 * import-wizard-mapping.test.tsx (P26b select migration) - the mapping
 * step's three column-mapping `Select`s (phone, optional name, per-row attr
 * column), replacing the native `<select>`s. Renders `MappingStep` directly
 * (not the full `ImportWizard`) with controlled state, same "render the step
 * component in isolation" idiom `composer.test.tsx` uses for `Composer`.
 */
const UPLOAD: UploadImportResult = {
  storageKey: 'uploads/test.csv',
  bytes: 128,
  columns: ['Phone', 'Full Name', 'City'],
  preview: [['+919000000000', 'Asha', 'Pune']],
  delimiter: ',',
  defaultCountry: 'IN',
};

/**
 * Selects a Base UI `Select` popup option in jsdom. `app/frontend` carries no
 * `@testing-library/user-event` dependency (see `theme-locale-menus.test.tsx`),
 * and a plain `fireEvent.click` alone does not trigger Base UI's pointer-based
 * item selection - the pointerdown/pointerup pair is required first.
 */
function clickOption(option: HTMLElement): void {
  fireEvent.pointerDown(option, { pointerId: 1, button: 0 });
  fireEvent.pointerUp(option, { pointerId: 1, button: 0 });
  fireEvent.click(option);
}

function Harness(): React.JSX.Element {
  const [phoneColumn, setPhoneColumn] = React.useState('Phone');
  const [nameColumn, setNameColumn] = React.useState('');
  const [attrRows, setAttrRows] = React.useState<AttrMappingRow[]>([
    { key: 'city', column: 'City' },
  ]);

  return (
    <I18nProvider locale="en">
      <MappingStep
        upload={UPLOAD}
        phoneColumn={phoneColumn}
        onPhoneColumnChange={setPhoneColumn}
        nameColumn={nameColumn}
        onNameColumnChange={setNameColumn}
        defaultCountry="IN"
        onDefaultCountryChange={() => undefined}
        attrRows={attrRows}
        onAttrRowsChange={setAttrRows}
        onContinue={() => undefined}
      />
    </I18nProvider>
  );
}

describe('ImportWizard mapping step selects', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders the phone column select with every upload column and the current value', () => {
    render(<Harness />);
    const phoneField = screen.getByTestId('import-mapping-phone');
    screen.getByText('Phone number column');
    expect(within(phoneField).getByText('Phone')).toBeTruthy();
  });

  it('choosing a phone column option calls onPhoneColumnChange with that column', async () => {
    render(<Harness />);
    const phoneField = screen.getByTestId('import-mapping-phone');
    fireEvent.click(within(phoneField).getByRole('combobox'));
    const option = await screen.findByRole('option', { name: 'Full Name' });
    clickOption(option);
    await waitFor(() => {
      expect(within(phoneField).getByText('Full Name')).toBeTruthy();
    });
  });

  it('the name column select is optional and shows the placeholder until an option is chosen', async () => {
    render(<Harness />);
    const nameField = screen.getByTestId('import-mapping-name');
    expect(within(nameField).getAllByText('Name column (optional)').length).toBeGreaterThan(0);
    fireEvent.click(within(nameField).getByRole('combobox'));
    const option = await screen.findByRole('option', { name: 'City' });
    clickOption(option);
    await waitFor(() => {
      expect(within(nameField).getByText('City')).toBeTruthy();
    });
  });

  it('the per-row attribute column select shows the current column and can be changed', async () => {
    render(<Harness />);
    const attrColumnField = screen.getByTestId('import-mapping-attr-column-0');
    expect(within(attrColumnField).getByText('City')).toBeTruthy();
    fireEvent.click(within(attrColumnField).getByRole('combobox'));
    const option = await screen.findByRole('option', { name: 'Phone' });
    clickOption(option);
    await waitFor(() => {
      expect(within(attrColumnField).getByText('Phone')).toBeTruthy();
    });
  });
});

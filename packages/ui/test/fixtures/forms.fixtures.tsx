import * as React from 'react';
import { Search } from 'lucide-react';
import {
  Button,
  IconButton,
  Input,
  Textarea,
  PasswordInput,
  Label,
  FormField,
  Select,
  Checkbox,
  Switch,
  RadioGroup,
} from '../../src/exports-forms.js';
import type { Fixture } from './types.js';

/** Axe fixtures for the forms primitives (P26b U1b-1 form controls (button, input, select, checkbox, switch, radio, form-field)). */
export const formsFixtures: readonly Fixture[] = [
  { name: 'Button (forms)', render: () => <Button variant="primary">Save</Button> },
  {
    name: 'IconButton',
    render: () => (
      <IconButton aria-label="Close">
        <Search aria-hidden size={16} />
      </IconButton>
    ),
  },
  { name: 'Input (forms)', render: () => <Input label="Recovery code" /> },
  { name: 'Textarea', render: () => <Textarea label="Message" rows={3} /> },
  {
    name: 'PasswordInput',
    render: () => (
      <PasswordInput label="Password" showLabel="Show password" hideLabel="Hide password" />
    ),
  },
  { name: 'Label', render: () => <Label htmlFor="forms-fixture-label">Display name</Label> },
  {
    name: 'FormField',
    render: () => (
      <FormField label="Display name" description="Shown to teammates">
        {(field) => <input {...field} />}
      </FormField>
    ),
  },
  {
    name: 'Select',
    render: () => (
      <Select
        label="Team"
        placeholder="Choose a team"
        options={[
          { value: 'sales', label: 'Sales' },
          { value: 'support', label: 'Support' },
        ]}
        value={null}
        onValueChange={() => {}}
      />
    ),
  },
  { name: 'Checkbox', render: () => <Checkbox label="Accept terms" /> },
  { name: 'Switch', render: () => <Switch label="Enable notifications" /> },
  {
    name: 'RadioGroup',
    render: () => (
      <RadioGroup
        label="Delivery method"
        options={[
          { value: 'sms', label: 'SMS' },
          { value: 'email', label: 'Email' },
        ]}
        value="sms"
        onValueChange={() => {}}
      />
    ),
  },
];

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
} from '../exports-forms.js';
import type { UiExample } from './types.js';

/** Gallery cards for the forms primitives (P26b U1b-1 form controls (button, input, select, checkbox, switch, radio, form-field)). */
export const formsExamples: readonly UiExample[] = [
  {
    name: 'Button',
    group: 'Forms',
    render: () => (
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary">Primary</Button>
        <Button variant="secondary">Secondary</Button>
        <Button variant="outline">Outline</Button>
        <Button variant="ghost">Ghost</Button>
        <Button variant="danger">Danger</Button>
        <Button variant="link">Link</Button>
        <Button loading loadingLabel="Loading">
          Saving
        </Button>
      </div>
    ),
  },
  {
    name: 'IconButton',
    group: 'Forms',
    render: () => (
      <IconButton aria-label="Search">
        <Search aria-hidden size={16} />
      </IconButton>
    ),
  },
  {
    name: 'Input',
    group: 'Forms',
    render: () => (
      <div className="flex max-w-xs flex-col gap-3">
        <Input label="Display name" description="Shown to teammates" />
        <Input label="Recovery code" error="That recovery code is not valid." />
      </div>
    ),
  },
  {
    name: 'Textarea',
    group: 'Forms',
    render: () => (
      <Textarea
        label="Message"
        rows={3}
        maxLength={120}
        counterLabel={(count, max) => `${String(count)}/${String(max)}`}
      />
    ),
  },
  {
    name: 'PasswordInput',
    group: 'Forms',
    render: () => (
      <PasswordInput label="Password" showLabel="Show password" hideLabel="Hide password" />
    ),
  },
  {
    name: 'Label',
    group: 'Forms',
    render: () => (
      <Label htmlFor="gallery-label-field" hint="Optional">
        Nickname
      </Label>
    ),
  },
  {
    name: 'FormField',
    group: 'Forms',
    render: () => (
      <FormField label="Display name" description="Shown to teammates" error="Required">
        {(field) => (
          <input
            {...field}
            className="h-9 rounded-md border border-border-strong bg-surface px-3 text-sm"
          />
        )}
      </FormField>
    ),
  },
  {
    name: 'Select',
    group: 'Forms',
    render: () => (
      <Select
        label="Team"
        placeholder="Choose a team"
        options={[
          { value: 'sales', label: 'Sales' },
          { value: 'support', label: 'Support', description: 'Front-line support team' },
        ]}
        value={null}
        onValueChange={() => {}}
      />
    ),
  },
  {
    name: 'Checkbox',
    group: 'Forms',
    render: () => <Checkbox label="Accept terms" description="Read the terms before continuing" />,
  },
  {
    name: 'Switch',
    group: 'Forms',
    render: () => <Switch label="Enable notifications" />,
  },
  {
    name: 'RadioGroup',
    group: 'Forms',
    render: () => (
      <RadioGroup
        label="Delivery method"
        options={[
          { value: 'sms', label: 'SMS' },
          { value: 'email', label: 'Email', description: 'Sent to your inbox' },
        ]}
        value="sms"
        onValueChange={() => {}}
      />
    ),
  },
];

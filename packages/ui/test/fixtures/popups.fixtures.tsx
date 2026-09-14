import * as React from 'react';
import { Button } from '../../src/button.js';
import { Dialog } from '../../src/dialog.js';
import { AlertDialog } from '../../src/alert-dialog.js';
import { DropdownMenu, type DropdownMenuItem } from '../../src/dropdown-menu.js';
import { Popover } from '../../src/popover.js';
import { Tooltip } from '../../src/tooltip.js';
import { Tabs, TabsPanel } from '../../src/tabs.js';
import { ScrollArea } from '../../src/scroll-area.js';
import { Collapsible } from '../../src/collapsible.js';
import { Kbd } from '../../src/kbd.js';
import { Progress } from '../../src/progress.js';
import { CommandPalette, type CommandPaletteItem } from '../../src/command-palette.js';
import type { Fixture } from './types.js';

const MENU_ITEMS: DropdownMenuItem[] = [
  { id: 'rename', label: 'Rename', onSelect: () => {} },
  { separator: true },
  { id: 'delete', label: 'Delete', destructive: true, onSelect: () => {} },
];

const PALETTE_ITEMS: CommandPaletteItem[] = [
  { id: 'go-dashboard', label: 'Go to dashboard', group: 'Navigation', onSelect: () => {} },
];

/** Axe fixtures for the popups primitives (P26b U1c-1 popup primitives (dialog, alert-dialog, sheet, menu, popover, tooltip, tabs, toast, progress, command palette)). */
export const popupsFixtures: readonly Fixture[] = [
  {
    name: 'Dialog',
    render: () => (
      <Dialog
        open
        onOpenChange={() => {}}
        title="Delete number"
        description="This cannot be undone."
        closeLabel="Close"
      >
        <p>Body content.</p>
      </Dialog>
    ),
  },
  {
    name: 'AlertDialog',
    render: () => (
      <AlertDialog
        open
        onOpenChange={() => {}}
        title="Delete instance"
        body="This cannot be undone."
        confirmLabel="Delete"
        cancelLabel="Cancel"
        onConfirm={() => {}}
        destructive
      />
    ),
  },
  {
    name: 'DropdownMenu',
    render: () => <DropdownMenu trigger={<Button size="sm">Actions</Button>} items={MENU_ITEMS} />,
  },
  {
    name: 'Popover',
    render: () => (
      <Popover trigger={<Button size="sm">Filters</Button>} title="Filters" open>
        <p>Narrow the list.</p>
      </Popover>
    ),
  },
  {
    name: 'Tooltip',
    render: () => (
      <Tooltip content="Pause the queue" delay={0}>
        <Button size="sm">Pause</Button>
      </Tooltip>
    ),
  },
  {
    name: 'Tabs',
    render: () => (
      <Tabs
        tabs={[
          { value: 'overview', label: 'Overview' },
          { value: 'settings', label: 'Settings' },
        ]}
        value="overview"
        onValueChange={() => {}}
      >
        <TabsPanel value="overview">Overview panel</TabsPanel>
        <TabsPanel value="settings">Settings panel</TabsPanel>
      </Tabs>
    ),
  },
  {
    name: 'ScrollArea',
    render: () => (
      <ScrollArea maxHeight="6rem">
        <p>Row one</p>
        <p>Row two</p>
        <p>Row three</p>
      </ScrollArea>
    ),
  },
  {
    name: 'Collapsible',
    render: () => (
      <Collapsible trigger="Advanced options">
        <p>Hidden content.</p>
      </Collapsible>
    ),
  },
  { name: 'Kbd', render: () => <Kbd>Ctrl K</Kbd> },
  {
    name: 'Progress',
    render: () => <Progress value={40} label="Import progress" valueText="40%" />,
  },
  {
    name: 'CommandPalette',
    render: () => (
      <CommandPalette
        open
        onOpenChange={() => {}}
        items={PALETTE_ITEMS}
        placeholder="Search actions..."
        emptyLabel="No results found."
        inputLabel="Command palette search"
      />
    ),
  },
];

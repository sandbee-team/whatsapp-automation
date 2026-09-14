'use client';

import * as React from 'react';
import { Button } from '../button.js';
import { Dialog } from '../dialog.js';
import { AlertDialog } from '../alert-dialog.js';
import { DropdownMenu, type DropdownMenuItem } from '../dropdown-menu.js';
import { Popover } from '../popover.js';
import { Tooltip } from '../tooltip.js';
import { Tabs, TabsPanel } from '../tabs.js';
import { ScrollArea } from '../scroll-area.js';
import { Collapsible } from '../collapsible.js';
import { Kbd } from '../kbd.js';
import { Progress } from '../progress.js';
import { CommandPalette, type CommandPaletteItem } from '../command-palette.js';
import type { UiExample } from './types.js';

const MENU_ITEMS: DropdownMenuItem[] = [
  { id: 'rename', label: 'Rename', onSelect: () => {} },
  { id: 'archive', label: 'Archive', onSelect: () => {} },
  { separator: true },
  { group: 'Danger zone' },
  { id: 'delete', label: 'Delete', destructive: true, onSelect: () => {} },
];

const PALETTE_ITEMS: CommandPaletteItem[] = [
  { id: 'go-dashboard', label: 'Go to dashboard', group: 'Navigation', onSelect: () => {} },
  { id: 'go-contacts', label: 'Go to contacts', group: 'Navigation', onSelect: () => {} },
  { id: 'pause-instance', label: 'Pause instance', group: 'Actions', onSelect: () => {} },
];

function DialogExample(): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        Open dialog
      </Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Delete number"
        description="This cannot be undone."
        closeLabel="Close"
      >
        <p className="text-sm text-muted">Body content goes here.</p>
      </Dialog>
    </>
  );
}

function AlertDialogExample(): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        Delete instance
      </Button>
      <AlertDialog
        open={open}
        onOpenChange={setOpen}
        title="Delete instance"
        body="This cannot be undone."
        confirmLabel="Delete"
        cancelLabel="Cancel"
        onConfirm={() => setOpen(false)}
        destructive
      />
    </>
  );
}

function PopoverExample(): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  return (
    <Popover
      trigger={
        <Button size="sm" onClick={() => setOpen(true)}>
          Open filters
        </Button>
      }
      title="Filters"
      open={open}
      onOpenChange={setOpen}
    >
      <p className="text-sm text-muted">Narrow the connected numbers list.</p>
    </Popover>
  );
}

function CommandPaletteExample(): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        Open command palette
      </Button>
      <CommandPalette
        open={open}
        onOpenChange={setOpen}
        items={PALETTE_ITEMS}
        placeholder="Search actions..."
        emptyLabel="No results found."
        inputLabel="Command palette search"
      />
    </>
  );
}

/** Gallery cards for the popups primitives (P26b U1c-1 popup primitives (dialog, alert-dialog, sheet, menu, popover, tooltip, tabs, toast, progress, command palette)). */
export const popupsExamples: readonly UiExample[] = [
  {
    name: 'Dialog',
    group: 'Overlays',
    render: () => <DialogExample />,
  },
  {
    name: 'AlertDialog',
    group: 'Overlays',
    render: () => <AlertDialogExample />,
  },
  {
    name: 'DropdownMenu',
    group: 'Overlays',
    render: () => <DropdownMenu trigger={<Button size="sm">Actions</Button>} items={MENU_ITEMS} />,
  },
  {
    name: 'Popover',
    group: 'Overlays',
    render: () => <PopoverExample />,
  },
  {
    name: 'Tooltip',
    group: 'Overlays',
    render: () => (
      <Tooltip content="Pause the queue" delay={0}>
        <Button size="sm">Pause</Button>
      </Tooltip>
    ),
  },
  {
    name: 'Tabs',
    group: 'Overlays',
    render: () => (
      <Tabs
        tabs={[
          { value: 'overview', label: 'Overview' },
          { value: 'messages', label: 'Messages', count: 12 },
        ]}
        value="overview"
        onValueChange={() => {}}
      >
        <TabsPanel value="overview">Overview panel content.</TabsPanel>
        <TabsPanel value="messages">Messages panel content.</TabsPanel>
      </Tabs>
    ),
  },
  {
    name: 'ScrollArea',
    group: 'Overlays',
    render: () => (
      <ScrollArea maxHeight="6rem" className="w-64 rounded-md border border-border p-2">
        <p className="py-1 text-sm">Row one</p>
        <p className="py-1 text-sm">Row two</p>
        <p className="py-1 text-sm">Row three</p>
        <p className="py-1 text-sm">Row four</p>
      </ScrollArea>
    ),
  },
  {
    name: 'Collapsible',
    group: 'Overlays',
    render: () => (
      <Collapsible trigger="Advanced options">
        <p>Hidden content revealed when expanded.</p>
      </Collapsible>
    ),
  },
  { name: 'Kbd', group: 'Overlays', render: () => <Kbd>Ctrl K</Kbd> },
  {
    name: 'Progress',
    group: 'Overlays',
    render: () => <Progress value={40} label="Import progress" valueText="40 of 100 contacts" />,
  },
  {
    name: 'CommandPalette',
    group: 'Overlays',
    render: () => <CommandPaletteExample />,
  },
];

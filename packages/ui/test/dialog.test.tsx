// @vitest-environment jsdom
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { Dialog } from '../src/dialog.js';

const AXE_OPTIONS: axe.RunOptions = {
  runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
  rules: { 'color-contrast': { enabled: false } },
};

function ControlledDialog({
  onOpenChange,
}: {
  onOpenChange?: (open: boolean) => void;
}): React.JSX.Element {
  const [open, setOpen] = React.useState(true);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        onOpenChange?.(next);
      }}
      title="Delete number"
      description="This cannot be undone."
      closeLabel="Close"
    >
      <button type="button">First field</button>
      <button type="button">Second field</button>
    </Dialog>
  );
}

function TriggeredDialog(): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>
        Open dialog
      </button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Delete number"
        description="This cannot be undone."
        closeLabel="Close"
      >
        <p>Body</p>
      </Dialog>
    </div>
  );
}

describe('Dialog', () => {
  afterEach(() => {
    cleanup();
  });

  it('wires aria-labelledby and aria-describedby to the title/description ids', () => {
    render(
      <Dialog
        open
        onOpenChange={() => {}}
        title="Delete number"
        description="This cannot be undone."
        closeLabel="Close"
      >
        <p>Body</p>
      </Dialog>,
    );
    const dialog = screen.getByRole('dialog');
    const titleId = dialog.getAttribute('aria-labelledby');
    const descriptionId = dialog.getAttribute('aria-describedby');
    expect(titleId).toBeTruthy();
    expect(descriptionId).toBeTruthy();
    expect(document.getElementById(titleId!)?.textContent).toBe('Delete number');
    expect(document.getElementById(descriptionId!)?.textContent).toBe('This cannot be undone.');
  });

  it('traps focus: Tab cycles inside the popup and never reaches the document body', async () => {
    const user = userEvent.setup();
    render(<ControlledDialog />);
    const first = screen.getByRole('button', { name: 'First field' });
    const second = screen.getByRole('button', { name: 'Second field' });
    const popup = screen.getByRole('dialog');

    await user.tab();
    expect(document.activeElement).toBe(first);
    await user.tab();
    expect(document.activeElement).toBe(second);
    // A further Tab must cycle back inside the popup, never escape to <body>.
    await user.tab();
    await user.tab();
    expect(document.activeElement).not.toBe(document.body);
    expect(popup.contains(document.activeElement) || document.activeElement === first).toBe(true);
  });

  it('Escape calls onOpenChange(false)', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(<ControlledDialog onOpenChange={onOpenChange} />);
    await user.keyboard('{Escape}');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('backdrop click calls onOpenChange(false)', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(<ControlledDialog onOpenChange={onOpenChange} />);
    const backdrop = document.querySelector('[data-testid="dialog-backdrop"]');
    expect(backdrop).toBeTruthy();
    await user.click(backdrop as Element);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('hideClose hides the close button', () => {
    render(
      <Dialog open onOpenChange={() => {}} title="Title" closeLabel="Close" hideClose>
        <p>Body</p>
      </Dialog>,
    );
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
  });

  it('renders the footer slot', () => {
    render(
      <Dialog
        open
        onOpenChange={() => {}}
        title="Title"
        closeLabel="Close"
        footer={<button type="button">Confirm</button>}
      >
        <p>Body</p>
      </Dialog>,
    );
    screen.getByRole('button', { name: 'Confirm' });
  });

  it('restores focus to the trigger element after closing (Escape)', async () => {
    const user = userEvent.setup();
    render(<TriggeredDialog />);
    const trigger = screen.getByRole('button', { name: 'Open dialog' });
    await user.click(trigger);
    screen.getByRole('dialog');
    // Base UI moves focus into the popup asynchronously - wait for it to
    // actually land there before treating the trigger's focus as the
    // "before" state this test proves gets restored.
    await waitFor(() => expect(document.activeElement).not.toBe(trigger));

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it('restores focus to the trigger element after closing (close button click)', async () => {
    const user = userEvent.setup();
    render(<TriggeredDialog />);
    const trigger = screen.getByRole('button', { name: 'Open dialog' });
    await user.click(trigger);
    await user.click(screen.getByRole('button', { name: 'Close' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it('has zero axe violations', async () => {
    const { container } = render(
      <Dialog
        open
        onOpenChange={() => {}}
        title="Delete number"
        description="This cannot be undone."
        closeLabel="Close"
      >
        <p>Body</p>
      </Dialog>,
    );
    const results = await axe.run(container, AXE_OPTIONS);
    expect(results.violations.length).toBe(0);
  });
});

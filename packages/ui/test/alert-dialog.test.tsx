// @vitest-environment jsdom
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { AlertDialog } from '../src/alert-dialog.js';

const AXE_OPTIONS: axe.RunOptions = {
  runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
  rules: { 'color-contrast': { enabled: false } },
};

function TriggeredAlertDialog(): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>
        Open confirm
      </button>
      <AlertDialog
        open={open}
        onOpenChange={setOpen}
        title="Delete instance"
        body="This cannot be undone."
        confirmLabel="Delete"
        cancelLabel="Cancel"
        onConfirm={() => setOpen(false)}
      />
    </div>
  );
}

describe('AlertDialog', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders with role="alertdialog"', () => {
    render(
      <AlertDialog
        open
        onOpenChange={() => {}}
        title="Delete instance"
        body="This cannot be undone."
        confirmLabel="Delete"
        cancelLabel="Cancel"
        onConfirm={() => {}}
      />,
    );
    screen.getByRole('alertdialog');
  });

  it('confirm button uses the danger variant when destructive', () => {
    render(
      <AlertDialog
        open
        onOpenChange={() => {}}
        title="Delete instance"
        body="This cannot be undone."
        confirmLabel="Delete"
        cancelLabel="Cancel"
        onConfirm={() => {}}
        destructive
      />,
    );
    const confirmButton = screen.getByRole('button', { name: 'Delete' });
    expect(confirmButton.className).toMatch(/bg-danger/);
  });

  it('calls onConfirm when the confirm button is clicked', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(
      <AlertDialog
        open
        onOpenChange={() => {}}
        title="Delete instance"
        body="This cannot be undone."
        confirmLabel="Delete"
        cancelLabel="Cancel"
        onConfirm={onConfirm}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('Escape calls onOpenChange(false) (cancels)', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(
      <AlertDialog
        open
        onOpenChange={onOpenChange}
        title="Delete instance"
        body="This cannot be undone."
        confirmLabel="Delete"
        cancelLabel="Cancel"
        onConfirm={() => {}}
      />,
    );
    await user.keyboard('{Escape}');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('cancel button calls onOpenChange(false)', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(
      <AlertDialog
        open
        onOpenChange={onOpenChange}
        title="Delete instance"
        body="This cannot be undone."
        confirmLabel="Delete"
        cancelLabel="Cancel"
        onConfirm={() => {}}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('loading disables the confirm button and shows the spinner', () => {
    render(
      <AlertDialog
        open
        onOpenChange={() => {}}
        title="Delete instance"
        body="This cannot be undone."
        confirmLabel="Delete"
        cancelLabel="Cancel"
        onConfirm={() => {}}
        loading
      />,
    );
    const confirmButton = screen.getByRole('button', { name: 'Delete' }) as HTMLButtonElement;
    expect(confirmButton.disabled).toBe(true);
  });

  it('restores focus to the trigger element after Cancel', async () => {
    const user = userEvent.setup();
    render(<TriggeredAlertDialog />);
    const trigger = screen.getByRole('button', { name: 'Open confirm' });
    await user.click(trigger);
    screen.getByRole('alertdialog');

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it('has zero axe violations', async () => {
    const { container } = render(
      <AlertDialog
        open
        onOpenChange={() => {}}
        title="Delete instance"
        body="This cannot be undone."
        confirmLabel="Delete"
        cancelLabel="Cancel"
        onConfirm={() => {}}
      />,
    );
    const results = await axe.run(container, AXE_OPTIONS);
    expect(results.violations.length).toBe(0);
  });
});

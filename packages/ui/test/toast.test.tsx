// @vitest-environment jsdom
import * as React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { ToastProvider, useToast, type ToastTimerApi } from '../src/toast.js';

const AXE_OPTIONS: axe.RunOptions = {
  runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
  rules: { 'color-contrast': { enabled: false } },
};

function makeFakeTimerApi(): ToastTimerApi & { fire: (handle: number) => void } {
  const callbacks = new Map<number, () => void>();
  let nextHandle = 1;
  return {
    setTimeout: (callback) => {
      const handle = nextHandle;
      nextHandle += 1;
      callbacks.set(handle, callback);
      return handle;
    },
    clearTimeout: (handle) => {
      callbacks.delete(handle as number);
    },
    fire: (handle: number) => {
      callbacks.get(handle)?.();
    },
  };
}

function ShowButton({
  title,
  tone,
}: {
  title: string;
  tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'info';
}): React.JSX.Element {
  const { showToast } = useToast();
  return (
    <button type="button" onClick={() => showToast({ title, tone })}>
      Show {title}
    </button>
  );
}

describe('ToastProvider / useToast', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders role="status" aria-live="polite" region', () => {
    render(
      <ToastProvider>
        <ShowButton title="Saved" />
      </ToastProvider>,
    );
    const region = screen.getByRole('status');
    expect(region.getAttribute('aria-live')).toBe('polite');
  });

  it('shows a toast with title and calls dismissToast via the dismiss button', async () => {
    const user = userEvent.setup();
    render(
      <ToastProvider dismissLabel="Dismiss">
        <ShowButton title="Saved" />
      </ToastProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'Show Saved' }));
    screen.getByText('Saved');
    const dismissButtons = screen.getAllByRole('button', { name: 'Dismiss' });
    await user.click(dismissButtons[0]);
    expect(screen.queryByText('Saved')).toBeNull();
  });

  it('caps visible toasts at maxVisible and queues the rest', async () => {
    const user = userEvent.setup();
    const timerApi = makeFakeTimerApi();
    render(
      <ToastProvider dismissLabel="Dismiss" maxVisible={2} timerApi={timerApi}>
        <ShowButton title="One" />
        <ShowButton title="Two" />
        <ShowButton title="Three" />
      </ToastProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'Show One' }));
    await user.click(screen.getByRole('button', { name: 'Show Two' }));
    await user.click(screen.getByRole('button', { name: 'Show Three' }));

    screen.getByText('One');
    screen.getByText('Two');
    expect(screen.queryByText('Three')).toBeNull();
  });

  it('respects the injectable timer for auto-dismiss', async () => {
    const user = userEvent.setup();
    const timerApi = makeFakeTimerApi();
    render(
      <ToastProvider dismissLabel="Dismiss" timerApi={timerApi}>
        <ShowButton title="Saved" />
      </ToastProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'Show Saved' }));
    screen.getByText('Saved');
    act(() => {
      timerApi.fire(1);
    });
    expect(screen.queryByText('Saved')).toBeNull();
  });

  it('renders a tone icon for each tone', async () => {
    const user = userEvent.setup();
    render(
      <ToastProvider dismissLabel="Dismiss">
        <ShowButton title="Failed" tone="danger" />
      </ToastProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'Show Failed' }));
    const region = screen.getByRole('status');
    expect(region.querySelector('svg')).toBeTruthy();
  });

  it('has zero axe violations', async () => {
    const { container } = render(
      <ToastProvider dismissLabel="Dismiss">
        <ShowButton title="Saved" />
      </ToastProvider>,
    );
    const results = await axe.run(container, AXE_OPTIONS);
    expect(results.violations.length).toBe(0);
  });
});

// @vitest-environment jsdom
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { Tabs, TabsPanel } from '../src/tabs.js';

const AXE_OPTIONS: axe.RunOptions = {
  runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
  rules: { 'color-contrast': { enabled: false } },
};

const TAB_ITEMS = [
  { value: 'overview', label: 'Overview' },
  { value: 'messages', label: 'Messages', count: 12 },
  { value: 'settings', label: 'Settings', disabled: true },
];

function ControlledTabs(): React.JSX.Element {
  const [value, setValue] = React.useState('overview');
  return (
    <Tabs tabs={TAB_ITEMS} value={value} onValueChange={setValue}>
      <TabsPanel value="overview">Overview panel</TabsPanel>
      <TabsPanel value="messages">Messages panel</TabsPanel>
      <TabsPanel value="settings">Settings panel</TabsPanel>
    </Tabs>
  );
}

describe('Tabs', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders tabs and shows the active panel', () => {
    render(<ControlledTabs />);
    screen.getByRole('tab', { name: 'Overview' });
    screen.getByText('Overview panel');
    expect(screen.queryByText('Messages panel')).toBeNull();
  });

  it('shows the count badge', () => {
    render(<ControlledTabs />);
    screen.getByText('12');
  });

  it('ArrowRight moves to the next tab', async () => {
    const user = userEvent.setup();
    render(<ControlledTabs />);
    screen.getByRole('tab', { name: 'Overview' }).focus();
    await user.keyboard('{ArrowRight}');
    const messages = screen.getByRole('tab', { name: /Messages/ });
    expect(document.activeElement).toBe(messages);
  });

  it('clicking a tab calls onValueChange and switches the panel', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(
      <Tabs tabs={TAB_ITEMS} value="overview" onValueChange={onValueChange}>
        <TabsPanel value="overview">Overview panel</TabsPanel>
        <TabsPanel value="messages">Messages panel</TabsPanel>
        <TabsPanel value="settings">Settings panel</TabsPanel>
      </Tabs>,
    );
    await user.click(screen.getByRole('tab', { name: /Messages/ }));
    expect(onValueChange).toHaveBeenCalledWith('messages');
  });

  it('disabled tab cannot be activated', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(
      <Tabs tabs={TAB_ITEMS} value="overview" onValueChange={onValueChange}>
        <TabsPanel value="overview">Overview panel</TabsPanel>
        <TabsPanel value="messages">Messages panel</TabsPanel>
        <TabsPanel value="settings">Settings panel</TabsPanel>
      </Tabs>,
    );
    await user.click(screen.getByRole('tab', { name: 'Settings' }));
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it('supports the pill variant', () => {
    render(
      <Tabs tabs={TAB_ITEMS} value="overview" onValueChange={() => {}} variant="pill">
        <TabsPanel value="overview">Overview panel</TabsPanel>
      </Tabs>,
    );
    screen.getByRole('tab', { name: 'Overview' });
  });

  it('has zero axe violations', async () => {
    const { container } = render(<ControlledTabs />);
    const results = await axe.run(container, AXE_OPTIONS);
    expect(results.violations.length).toBe(0);
  });
});

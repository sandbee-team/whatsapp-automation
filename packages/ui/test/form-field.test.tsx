// @vitest-environment jsdom
import * as React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import axe from 'axe-core';
import { FormField } from '../src/form-field.js';

const AXE_OPTIONS: axe.RunOptions = {
  runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
  rules: { 'color-contrast': { enabled: false } },
};

describe('FormField', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders the label, associates it via the generated id, and passes field props through', () => {
    render(
      <FormField label="Display name">
        {(field) => <input {...field} data-testid="control" />}
      </FormField>,
    );
    const input = screen.getByLabelText('Display name');
    expect(input).toBe(screen.getByTestId('control'));
  });

  it('lists description and error ids in aria-describedby and sets aria-invalid only with an error', () => {
    render(
      <FormField label="Display name" description="Shown to teammates" error="Required">
        {(field) => <input {...field} data-testid="control" />}
      </FormField>,
    );
    const input = screen.getByTestId('control');
    const describedBy = input.getAttribute('aria-describedby') ?? '';
    const ids = describedBy.split(' ');
    expect(ids).toHaveLength(2);
    for (const id of ids) {
      expect(document.getElementById(id)).not.toBeNull();
    }
    expect(input.getAttribute('aria-invalid')).toBe('true');
  });

  it('omits aria-invalid when there is no error', () => {
    render(
      <FormField label="Display name">
        {(field) => <input {...field} data-testid="control" />}
      </FormField>,
    );
    const input = screen.getByTestId('control');
    expect(input.getAttribute('aria-invalid')).toBeNull();
  });

  it('renders the error text as a plain paragraph, not an alert', () => {
    render(
      <FormField label="Display name" error="Required">
        {(field) => <input {...field} data-testid="control" />}
      </FormField>,
    );
    const error = screen.getByText('Required');
    expect(error.getAttribute('role')).toBeNull();
  });

  it('accepts an explicit htmlFor', () => {
    render(
      <FormField label="Display name" htmlFor="custom-id">
        {(field) => <input {...field} data-testid="control" />}
      </FormField>,
    );
    expect(screen.getByTestId('control').id).toBe('custom-id');
  });

  it('has zero axe violations', async () => {
    const { container } = render(
      <FormField label="Display name" description="Shown to teammates" error="Required">
        {(field) => <input {...field} />}
      </FormField>,
    );
    const results = await axe.run(container, AXE_OPTIONS);
    expect(results.violations.length).toBe(0);
  });
});

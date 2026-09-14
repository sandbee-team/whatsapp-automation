// @vitest-environment jsdom
import * as React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import axe from 'axe-core';
import { QrDisplay } from '../src/qr-display.js';

const AXE_OPTIONS: axe.RunOptions = {
  runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
  rules: { 'color-contrast': { enabled: false } },
};

const SRC = 'data:image/png;base64,AAAA';

describe('QrDisplay', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders the QR image with the label as alt text', () => {
    render(<QrDisplay src={SRC} label="Scan to link WhatsApp" />);
    const image = screen.getByAltText('Scan to link WhatsApp');
    expect(image.getAttribute('src')).toBe(SRC);
  });

  it('applies the default size and an overridden size', () => {
    const { rerender } = render(<QrDisplay src={SRC} label="Scan" />);
    const image = screen.getByAltText('Scan') as HTMLImageElement;
    expect(image.getAttribute('width')).toBe('240');

    rerender(<QrDisplay src={SRC} label="Scan" size={320} />);
    expect(screen.getByAltText('Scan').getAttribute('width')).toBe('320');
  });

  it('dims the image and shows the expired overlay when expired', () => {
    render(
      <QrDisplay
        src={SRC}
        label="Scan"
        expired
        expiredOverlay={<span>Code expired, refresh to continue</span>}
      />,
    );
    expect(screen.getByText('Code expired, refresh to continue')).toBeTruthy();
    const image = screen.getByAltText('Scan');
    expect(image.className).toContain('opacity');
  });

  it('renders the footer slot when supplied', () => {
    render(<QrDisplay src={SRC} label="Scan" footer={<span>Refreshing in 30s</span>} />);
    expect(screen.getByText('Refreshing in 30s')).toBeTruthy();
  });

  it('has zero axe violations', async () => {
    const { container } = render(<QrDisplay src={SRC} label="Scan to link WhatsApp" />);
    const results = await axe.run(container, AXE_OPTIONS);
    expect(results.violations.length).toBe(0);
  });
});

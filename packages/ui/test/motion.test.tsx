// @vitest-environment jsdom
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Reveal, Stagger, AnimatedNumber, useCountUp } from '../src/motion.js';

/**
 * Reveal/Stagger/AnimatedNumber/useCountUp (panel-refresh spec section 3,
 * unit F1). `useCountUp` and `AnimatedNumber` are exercised through a tiny
 * host component since hooks cannot be called outside a component.
 */

describe('Reveal', () => {
  afterEach(() => {
    cleanup();
  });

  it('defaults to the rise variant animate class plus the motion-reduce fallback', () => {
    render(<Reveal data-testid="reveal">content</Reveal>);
    const el = screen.getByTestId('reveal');
    expect(el.className).toContain('animate-rise-in');
    expect(el.className).toContain('motion-reduce:animate-none');
  });

  it('renders the pop variant animate class', () => {
    render(
      <Reveal variant="pop" data-testid="reveal">
        content
      </Reveal>,
    );
    expect(screen.getByTestId('reveal').className).toContain('animate-pop-in');
  });

  it('renders the fade variant animate class', () => {
    render(
      <Reveal variant="fade" data-testid="reveal">
        content
      </Reveal>,
    );
    expect(screen.getByTestId('reveal').className).toContain('animate-fade-in');
  });

  it('sets the inline animationDelay from delayMs', () => {
    render(
      <Reveal delayMs={240} data-testid="reveal">
        content
      </Reveal>,
    );
    const el = screen.getByTestId('reveal');
    expect(el.style.animationDelay).toBe('240ms');
  });

  it('renders as the requested element via "as"', () => {
    render(
      <Reveal as="li" data-testid="reveal">
        content
      </Reveal>,
    );
    expect(screen.getByTestId('reveal').tagName).toBe('LI');
  });
});

describe('Stagger', () => {
  afterEach(() => {
    cleanup();
  });

  it('assigns each child an animationDelay of startMs + index*stepMs', () => {
    render(
      <Stagger startMs={100} stepMs={60}>
        <div data-testid="child-0">a</div>
        <div data-testid="child-1">b</div>
        <div data-testid="child-2">c</div>
      </Stagger>,
    );
    const wrapper0 = screen.getByTestId('child-0').parentElement;
    const wrapper1 = screen.getByTestId('child-1').parentElement;
    const wrapper2 = screen.getByTestId('child-2').parentElement;
    expect(wrapper0?.style.animationDelay).toBe('100ms');
    expect(wrapper1?.style.animationDelay).toBe('160ms');
    expect(wrapper2?.style.animationDelay).toBe('220ms');
  });

  it('defaults stepMs to 60 and startMs to 0', () => {
    render(
      <Stagger>
        <div data-testid="child-0">a</div>
        <div data-testid="child-1">b</div>
      </Stagger>,
    );
    expect(screen.getByTestId('child-0').parentElement?.style.animationDelay).toBe('0ms');
    expect(screen.getByTestId('child-1').parentElement?.style.animationDelay).toBe('60ms');
  });

  it('renders a single container that carries the className and rest props', () => {
    render(
      <Stagger className="grid gap-4" data-testid="stagger-container">
        <div data-testid="child-0">a</div>
        <div data-testid="child-1">b</div>
      </Stagger>,
    );
    const container = screen.getByTestId('stagger-container');
    expect(container.className).toContain('grid gap-4');
    expect(screen.getByTestId('child-0').parentElement?.parentElement).toBe(container);
    expect(screen.getByTestId('child-1').parentElement?.parentElement).toBe(container);
    // Exactly one container - no per-child duplication of the container className.
    expect(container.children.length).toBe(2);
  });

  it('defaults the container to a div and each wrapper to a div', () => {
    render(
      <Stagger data-testid="stagger-container">
        <div data-testid="child-0">a</div>
      </Stagger>,
    );
    const container = screen.getByTestId('stagger-container');
    expect(container.tagName).toBe('DIV');
    expect(screen.getByTestId('child-0').parentElement?.tagName).toBe('DIV');
  });

  it('renders a ul container with li wrappers when as="ul"', () => {
    render(
      <Stagger as="ul" data-testid="stagger-container">
        <div data-testid="child-0">a</div>
        <div data-testid="child-1">b</div>
      </Stagger>,
    );
    const container = screen.getByTestId('stagger-container');
    expect(container.tagName).toBe('UL');
    expect(screen.getByTestId('child-0').parentElement?.tagName).toBe('LI');
    expect(screen.getByTestId('child-1').parentElement?.tagName).toBe('LI');
  });
});

function CountUpHost({ target }: { target: number }): React.JSX.Element {
  const displayed = useCountUp(target);
  return <span data-testid="count">{displayed}</span>;
}

describe('useCountUp', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('jumps straight to the target when requestAnimationFrame is unavailable', () => {
    const original = window.requestAnimationFrame;
    // @ts-expect-error - simulating an environment without rAF, as the spec requires.
    delete window.requestAnimationFrame;
    render(<CountUpHost target={42} />);
    expect(screen.getByTestId('count').textContent).toBe('42');
    window.requestAnimationFrame = original;
  });

  it('jumps straight to the target when prefers-reduced-motion is set', () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockReturnValue({
        matches: true,
        media: '(prefers-reduced-motion: reduce)',
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    );
    render(<CountUpHost target={99} />);
    expect(screen.getByTestId('count').textContent).toBe('99');
  });
});

describe('AnimatedNumber', () => {
  afterEach(() => {
    cleanup();
  });

  it('carries data-target with the final value and renders inside a tabular-nums span', () => {
    const { container } = render(<AnimatedNumber value={1204} />);
    const el = container.querySelector('span');
    expect(el?.getAttribute('data-target')).toBe('1204');
    expect(el?.className).toContain('tabular-nums');
  });

  it('applies the format function to the displayed value eventually reaching the target', () => {
    const { container } = render(
      <AnimatedNumber value={1204} format={(n) => `${n.toLocaleString('en-IN')} sent`} />,
    );
    const el = container.querySelector('span');
    // The displayed text is formatted (not the raw number) even mid-count-up.
    expect(el?.textContent).toContain('sent');
  });
});

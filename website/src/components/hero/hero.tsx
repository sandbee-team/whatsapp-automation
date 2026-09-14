import type * as React from 'react';
import Link from 'next/link';
import { HOME_COPY } from '../../content/copy/home.js';
import { HeroMotionIsland } from './hero-motion-island.js';

/**
 * hero.tsx (P29 U2; motion island removed P29 step 6/U5, restored P29 step
 * 6/U5b) - the h1 is the LCP element: visible with no JS (no opacity-0
 * initial state, no transform-in, no font swap). The `HeroMotionIsland`
 * client boundary was dropped after the India-4G LCP budget
 * (docs/evidence/P29-lcp-india4g.md) was missed with it in place; the real
 * cause was later found to be the perf harness serving assets
 * uncompressed (U5b) - once the harness was fixed to compress like
 * production, the budget held with wide margin (all three routes <= 1.6s),
 * so the island was restored. gsap stays confined to the lazily-loaded
 * `hero-motion.js` module (`ssr: false`) and never enters the initial
 * bundle; see that evidence file for the measured island-off/island-on
 * numbers.
 */
export function Hero(): React.JSX.Element {
  const { hero } = HOME_COPY;
  return (
    <section className="grid gap-8 py-16 md:grid-cols-2 md:items-center">
      <div>
        <h1 className="text-4xl font-semibold tracking-tight text-fg md:text-5xl">
          {hero.heading}
        </h1>
        <p className="mt-4 max-w-prose text-lg text-muted">{hero.subline}</p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Link
            href="/pricing/"
            className="inline-flex h-10 items-center rounded-md bg-accent px-5 text-accent-fg shadow-sm hover:bg-accent-hover"
          >
            {hero.ctaPrimary}
          </Link>
          <Link
            href="/docs/"
            className="inline-flex h-10 items-center rounded-md border border-border-strong px-5 text-fg hover:bg-surface-2"
          >
            {hero.ctaSecondary}
          </Link>
        </div>
      </div>
      <div
        data-hero-motion="panel"
        aria-hidden="true"
        className="hero-panel-fade-in relative h-64 overflow-hidden rounded-xl border border-border bg-surface shadow-card md:h-80"
      >
        <div
          data-hero-motion="orb-1"
          className="hero-panel-fade-in absolute -left-8 -top-8 h-40 w-40 rounded-full bg-accent-soft"
        />
        <div
          data-hero-motion="orb-2"
          className="hero-panel-fade-in absolute -bottom-10 -right-10 h-56 w-56 rounded-full bg-info-soft"
        />
      </div>
      <HeroMotionIsland />
    </section>
  );
}

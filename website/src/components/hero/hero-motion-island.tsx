'use client';

import type * as React from 'react';
import dynamic from 'next/dynamic';

/**
 * hero-motion-island.tsx (P29 U2) - client boundary that lazily loads the
 * gsap-dependent animation module (`ssr: false`) so `gsap` never enters the
 * server render or the initial client bundle needed for the LCP paint.
 */
const HeroMotion = dynamic(() => import('./hero-motion.js'), { ssr: false });

export function HeroMotionIsland(): React.JSX.Element {
  return <HeroMotion />;
}

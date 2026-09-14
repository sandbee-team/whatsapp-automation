'use client';

import { useEffect } from 'react';

/**
 * hero-motion.tsx (P29 U2) - animates ONLY decorative elements marked
 * `data-hero-motion` (never the h1 or any text). Bails out entirely when
 * `prefers-reduced-motion: reduce` is set, before ever importing `gsap`.
 * The string 'gsap' must appear in no other source file in this package.
 */
export default function HeroMotion(): null {
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      return undefined;
    }

    let cancelled = false;
    let cleanup: (() => void) | undefined;

    void import('gsap').then(({ gsap }) => {
      if (cancelled) {
        return;
      }
      const targets = document.querySelectorAll('[data-hero-motion]');
      const tween = gsap.from(targets, {
        opacity: 0,
        y: 16,
        duration: 0.6,
        stagger: 0.1,
        ease: 'power2.out',
      });
      cleanup = () => tween.kill();
    });

    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, []);

  return null;
}

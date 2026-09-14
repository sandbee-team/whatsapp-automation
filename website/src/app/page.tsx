import type * as React from 'react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { buildMetadata } from '../lib/seo.js';
import { HOME_COPY } from '../content/copy/home.js';
import { Hero } from '../components/hero/hero.js';

export const metadata: Metadata = buildMetadata({
  title: 'WP - WhatsApp messaging infrastructure',
  description: HOME_COPY.hero.subline,
  path: '/',
});

export default function HomePage(): React.JSX.Element {
  const { whatItIsNot, howItWorks, ctas } = HOME_COPY;
  return (
    <>
      <Hero />
      <section className="py-12">
        <h2 className="text-2xl font-semibold text-fg">{whatItIsNot.heading}</h2>
        <ul className="mt-4 space-y-3 text-muted">
          {whatItIsNot.bullets.map((bullet) => (
            <li key={bullet}>{bullet}</li>
          ))}
        </ul>
      </section>
      <section className="py-12">
        <h2 className="text-2xl font-semibold text-fg">{howItWorks.heading}</h2>
        <ol className="mt-4 space-y-3 text-muted">
          {howItWorks.steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      </section>
      <section className="flex gap-3 pb-16">
        <Link
          href="/pricing/"
          className="inline-flex h-10 items-center rounded-md bg-accent px-5 text-accent-fg shadow-sm hover:bg-accent-hover"
        >
          {ctas.pricing}
        </Link>
        <Link
          href="/docs/"
          className="inline-flex h-10 items-center rounded-md border border-border-strong px-5 text-fg hover:bg-surface-2"
        >
          {ctas.docs}
        </Link>
      </section>
    </>
  );
}

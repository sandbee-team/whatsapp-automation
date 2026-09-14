import type * as React from 'react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { buildMetadata } from '../../../lib/seo.js';
import { PRICING_COPY } from '../../../content/copy/pricing.js';

export const metadata: Metadata = buildMetadata({
  title: 'Pricing - WP',
  description: PRICING_COPY.intro,
  path: '/pricing/',
});

export default function PricingPage(): React.JSX.Element {
  const { howBillingWorks, cta } = PRICING_COPY;
  return (
    <section className="py-12">
      <h1 className="text-3xl font-semibold text-fg">{PRICING_COPY.heading}</h1>
      <p className="mt-4 text-lg text-muted">{PRICING_COPY.intro}</p>
      <h2 className="mt-8 text-2xl font-semibold text-fg">{howBillingWorks.heading}</h2>
      <div className="mt-4 space-y-3 text-muted">
        {howBillingWorks.paragraphs.map((paragraph) => (
          <p key={paragraph}>{paragraph}</p>
        ))}
      </div>
      <Link
        href={cta.href}
        className="mt-8 inline-flex h-10 items-center rounded-md bg-accent px-5 text-accent-fg shadow-sm hover:bg-accent-hover"
      >
        {cta.label}
      </Link>
    </section>
  );
}

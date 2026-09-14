import type * as React from 'react';
import type { Metadata } from 'next';
import { buildMetadata } from '../../../lib/seo.js';
import { FEATURES_COPY } from '../../../content/copy/features.js';
import { Disclosure } from '../../../lib/disclosures.js';

export const metadata: Metadata = buildMetadata({
  title: 'Features - WP',
  description: FEATURES_COPY.intro,
  path: '/features/',
});

export default function FeaturesPage(): React.JSX.Element {
  return (
    <section className="py-12">
      <h1 className="text-3xl font-semibold text-fg">{FEATURES_COPY.heading}</h1>
      <p className="mt-4 max-w-prose text-muted">{FEATURES_COPY.intro}</p>
      <dl className="mt-8 grid gap-8 md:grid-cols-2">
        {FEATURES_COPY.items.map((item) => (
          <div key={item.title}>
            <dt className="text-lg font-semibold text-fg">{item.title}</dt>
            <dd className="mt-2 text-muted">{item.body}</dd>
            {'disclosure' in item ? <Disclosure text={item.disclosure} /> : null}
          </div>
        ))}
      </dl>
    </section>
  );
}

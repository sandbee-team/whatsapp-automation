import type * as React from 'react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { buildMetadata } from '../../../lib/seo.js';
import { DOCS_COPY } from '../../../content/copy/docs.js';
import { listDocs } from '../../../lib/content.js';

export const metadata: Metadata = buildMetadata({
  title: 'Docs - WP',
  description: DOCS_COPY.index.intro,
  path: '/docs/',
});

export default function DocsIndexPage(): React.JSX.Element {
  const docs = listDocs();
  const englishDocs = docs.filter((doc) => doc.meta.lang === 'en');
  const hindiDocs = docs.filter((doc) => doc.meta.lang === 'hi');

  return (
    <section className="py-12">
      <h1 className="text-3xl font-semibold text-fg">{DOCS_COPY.index.heading}</h1>
      <p className="mt-4 max-w-prose text-muted">{DOCS_COPY.index.intro}</p>

      <h2 className="mt-8 text-xl font-semibold text-fg">{DOCS_COPY.index.englishHeading}</h2>
      <ul className="mt-4 space-y-2">
        {englishDocs.map((doc) => (
          <li key={doc.meta.slug}>
            <Link href={`/docs/${doc.meta.slug}/`} className="text-accent underline">
              {doc.meta.title}
            </Link>
            <p className="text-sm text-muted">{doc.meta.description}</p>
          </li>
        ))}
      </ul>

      {hindiDocs.length > 0 ? (
        <>
          <h2 className="mt-8 text-xl font-semibold text-fg">{DOCS_COPY.index.hindiHeading}</h2>
          <ul className="mt-4 space-y-2">
            {hindiDocs.map((doc) => (
              <li key={doc.meta.slug}>
                <Link href={`/docs/${doc.meta.slug}/`} lang="hi" className="text-accent underline">
                  {doc.meta.title}
                </Link>
                <p className="text-sm text-muted" lang="hi">
                  {doc.meta.description}
                </p>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}

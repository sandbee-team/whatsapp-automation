import type * as React from 'react';
import type { Metadata } from 'next';
import { MDXRemote } from 'next-mdx-remote/rsc';
import remarkGfm from 'remark-gfm';
import { buildMetadata } from '../../../../lib/seo.js';
import { DOCS_COPY } from '../../../../content/copy/docs.js';
import { getLegal } from '../../../../lib/content.js';
import { mdxComponents } from '../../../../lib/mdx-components.js';

const legal = getLegal('privacy');

export const metadata: Metadata = buildMetadata({
  title: `${legal.meta.title} - WP`,
  description: legal.meta.description,
  path: '/legal/privacy/',
});

export default function PrivacyPage(): React.JSX.Element {
  return (
    <article className="py-12">
      <h1 className="text-3xl font-semibold text-fg">{DOCS_COPY.legal.privacy.heading}</h1>
      <div className="prose mt-6 max-w-prose text-muted">
        <MDXRemote
          source={legal.body}
          components={mdxComponents}
          options={{ mdxOptions: { remarkPlugins: [remarkGfm] } }}
        />
      </div>
    </article>
  );
}

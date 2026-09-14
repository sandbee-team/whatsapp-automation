import type * as React from 'react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { buildMetadata } from '../../../lib/seo.js';
import { DOCS_COPY } from '../../../content/copy/docs.js';
import { listPosts } from '../../../lib/content.js';

export const metadata: Metadata = buildMetadata({
  title: 'Blog - WP',
  description: DOCS_COPY.blogIndex.intro,
  path: '/blog/',
});

export default function BlogIndexPage(): React.JSX.Element {
  const posts = listPosts();

  return (
    <section className="py-12">
      <h1 className="text-3xl font-semibold text-fg">{DOCS_COPY.blogIndex.heading}</h1>
      <p className="mt-4 max-w-prose text-muted">{DOCS_COPY.blogIndex.intro}</p>

      <ul className="mt-8 space-y-6">
        {posts.map((post) => (
          <li key={post.meta.slug}>
            <Link href={`/blog/${post.meta.slug}/`} className="text-lg text-accent underline">
              {post.meta.title}
            </Link>
            {post.meta.date ? <p className="text-sm text-muted">{post.meta.date}</p> : null}
            <p className="mt-1 text-muted">{post.meta.description}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

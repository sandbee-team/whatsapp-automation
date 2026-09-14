import type * as React from 'react';
import Link from 'next/link';

/**
 * mdx-components.tsx (P29 U3) - shared rendering components for docs/blog
 * MDX content. Internal links use `next/link` (static export - no full
 * page reload); headings get stable ids for future in-page anchors.
 *
 * Typed as a plain record (not `next-mdx-remote`'s own `MDXComponents`
 * export type) because that type is re-exported from `mdx/types`, which is
 * not directly resolvable from this workspace's `node_modules` layout;
 * `MDXRemote`'s `components` prop accepts this shape structurally.
 */
export type MdxComponentMap = Record<string, React.ComponentType<Record<string, unknown>>>;
function slugify(children: React.ReactNode): string {
  return String(children)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

function Heading2({ children }: { children?: React.ReactNode }): React.JSX.Element {
  return (
    <h2 id={slugify(children)} className="mt-8 text-2xl font-semibold text-fg">
      {children}
    </h2>
  );
}

function Heading3({ children }: { children?: React.ReactNode }): React.JSX.Element {
  return (
    <h3 id={slugify(children)} className="mt-6 text-xl font-semibold text-fg">
      {children}
    </h3>
  );
}

function MdxAnchor({
  href,
  children,
}: {
  href?: string;
  children?: React.ReactNode;
}): React.JSX.Element {
  if (href?.startsWith('/')) {
    return (
      <Link href={href} className="text-accent underline">
        {children}
      </Link>
    );
  }
  return (
    <a href={href} className="text-accent underline">
      {children}
    </a>
  );
}

function MdxTable({ children }: { children?: React.ReactNode }): React.JSX.Element {
  return (
    <table className="mt-4 w-full border-collapse border border-border text-sm">{children}</table>
  );
}

function MdxTableCell({ children }: { children?: React.ReactNode }): React.JSX.Element {
  return <td className="border border-border px-3 py-2 text-muted">{children}</td>;
}

function MdxTableHeaderCell({ children }: { children?: React.ReactNode }): React.JSX.Element {
  return (
    <th className="border border-border px-3 py-2 text-left font-semibold text-fg">{children}</th>
  );
}

export const mdxComponents: MdxComponentMap = {
  h2: Heading2,
  h3: Heading3,
  a: MdxAnchor,
  table: MdxTable,
  td: MdxTableCell,
  th: MdxTableHeaderCell,
};

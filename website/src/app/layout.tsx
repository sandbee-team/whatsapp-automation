import type * as React from 'react';
import type { Metadata } from 'next';
import Link from 'next/link';
import '../styles/globals.css';
import { buildMetadata, organizationJsonLd, serializeJsonLd } from '../lib/seo.js';
import { SHARED_COPY } from '../content/copy/shared.js';
import { UiSmoke } from '../components/ui-smoke.js';

export const metadata: Metadata = buildMetadata({
  title: 'WP - WhatsApp messaging infrastructure',
  description: SHARED_COPY.tagline,
  path: '/',
});

export default function RootLayout({ children }: { children: React.ReactNode }): React.JSX.Element {
  const { nav, footer } = SHARED_COPY;
  return (
    <html lang="en">
      <body>
        <header className="border-b border-border">
          <nav className="mx-auto flex max-w-5xl items-center gap-6 px-6 py-4 text-sm">
            <Link href="/" className="font-semibold text-fg">
              WP
            </Link>
            <Link href="/" className="text-muted hover:text-fg">
              {nav.home}
            </Link>
            <Link href="/features/" className="text-muted hover:text-fg">
              {nav.features}
            </Link>
            <Link href="/pricing/" className="text-muted hover:text-fg">
              {nav.pricing}
            </Link>
            <Link href="/docs/" className="text-muted hover:text-fg">
              {nav.docs}
            </Link>
            <Link href="/blog/" className="text-muted hover:text-fg">
              {nav.blog}
            </Link>
          </nav>
        </header>
        <main className="mx-auto max-w-5xl px-6">{children}</main>
        <footer className="mt-16 border-t border-border">
          <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-4 px-6 py-8 text-sm text-muted">
            <div className="flex gap-4">
              <Link href="/legal/terms/" className="hover:text-fg">
                {footer.terms}
              </Link>
              <Link href="/legal/privacy/" className="hover:text-fg">
                {footer.privacy}
              </Link>
              <Link href="/legal/dpa/" className="hover:text-fg">
                {footer.dpa}
              </Link>
              <Link href="/contact/" className="hover:text-fg">
                {footer.contact}
              </Link>
            </div>
            <UiSmoke />
          </div>
        </footer>
        {/* JSON-LD is the sanctioned use of dangerouslySetInnerHTML: static, server-built JSON, never user input, and
            serialised through `serializeJsonLd` (escapes `<`, `>`, `&`, U+2028/9 so a `</script>` break-out is impossible).
            That serializer is the explicit sanitizer the semgrep rule asks for - hence the scoped exemption below. */}
        {/* nosemgrep: wp.no-dangerously-set-inner-html-dynamic */}
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: serializeJsonLd(organizationJsonLd()) }}
        />
      </body>
    </html>
  );
}

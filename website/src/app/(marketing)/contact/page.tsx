import type * as React from 'react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { buildMetadata } from '../../../lib/seo.js';
import { CONTACT_COPY } from '../../../content/copy/contact.js';
import { LeadForm } from '../../../components/lead-form.js';

export const metadata: Metadata = buildMetadata({
  title: 'Contact - WP',
  description: CONTACT_COPY.intro,
  path: '/contact/',
});

export default function ContactPage(): React.JSX.Element {
  return (
    <section className="py-12">
      <h1 className="text-3xl font-semibold text-fg">{CONTACT_COPY.heading}</h1>
      <p className="mt-4 max-w-prose text-muted">{CONTACT_COPY.intro}</p>
      <LeadForm source="contact" />
      <p className="mt-6 max-w-prose text-sm text-muted">
        {CONTACT_COPY.privacyNote}{' '}
        <Link href="/legal/privacy/" className="text-accent hover:underline">
          {CONTACT_COPY.privacyLinkLabel}
        </Link>
      </p>
    </section>
  );
}

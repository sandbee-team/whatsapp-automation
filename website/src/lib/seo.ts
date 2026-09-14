import type { Metadata } from 'next';

/**
 * seo.ts (P29 U2) - shared SEO helpers for the static-export marketing
 * site: canonical `Metadata` builder plus the Organization JSON-LD block.
 * Plain descriptions only - no superlatives, no capacity/price figures
 * (copy discipline: core invariant 6 / safety-compliance).
 */
export const SITE_ORIGIN = process.env.NEXT_PUBLIC_SITE_ORIGIN ?? 'http://localhost:3002';

const POSITIONING_LINE =
  'Reliable, controlled WhatsApp messaging infrastructure: durable queues, paced sending, health monitoring, and safe pause and resume.';

export interface BuildMetadataInput {
  title: string;
  description: string;
  path: string;
}

export function buildMetadata({ title, description, path }: BuildMetadataInput): Metadata {
  return {
    metadataBase: new URL(SITE_ORIGIN),
    title,
    description,
    alternates: { canonical: path },
    openGraph: {
      title,
      description,
      url: path,
      siteName: 'WP',
      type: 'website',
    },
    twitter: { card: 'summary' },
  };
}

export function organizationJsonLd(): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: 'WP',
    url: SITE_ORIGIN,
    description: POSITIONING_LINE,
  };
}

/**
 * The ONE sanitizer for JSON-LD embedded in a `<script type="application/ld+json">`
 * (P29a step 7, semgrep rule `wp.no-dangerously-set-inner-html-dynamic`).
 * `JSON.stringify` alone is not safe inside a script element: a string value
 * containing `</script>` (or a U+2028/U+2029 line terminator) ends the element
 * early. Escaping `<`, `>`, `&` and the two line terminators as `\uXXXX`
 * sequences keeps the payload valid JSON while making a break-out impossible,
 * whatever the object contains. Every `dangerouslySetInnerHTML` for JSON-LD
 * goes through this function - never raw `JSON.stringify`.
 */
export function serializeJsonLd(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

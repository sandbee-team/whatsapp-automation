/**
 * docs.ts (P29 U3) - chrome copy (headings/intros) for the /docs/, /blog/
 * and /legal/* index and listing pages. The MDX bodies themselves live
 * under website/content/**; this file only covers page furniture.
 */
export const DOCS_COPY = {
  index: {
    heading: 'Docs',
    intro: 'Plain explanations of how sending, pacing and billing actually work.',
    englishHeading: 'English',
    hindiHeading: 'हिन्दी',
  },
  doc: {
    backLabel: 'Back to docs',
  },
  blogIndex: {
    heading: 'Blog',
    intro: 'Notes on how WP is built and what it does and does not promise.',
  },
  blogPost: {
    backLabel: 'Back to blog',
  },
  legal: {
    terms: { heading: 'Terms of Service' },
    privacy: { heading: 'Privacy Notice' },
    dpa: { heading: 'Data Processing Addendum' },
  },
} as const;

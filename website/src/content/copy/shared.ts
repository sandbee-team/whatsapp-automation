/**
 * shared.ts (P29 U2) - copy used across more than one page/layout: nav,
 * footer, and the site tagline. Every user-facing string lives in a copy
 * module; pages/components never hand-roll product copy.
 */
export const SHARED_COPY = {
  nav: {
    home: 'Home',
    features: 'Features',
    pricing: 'Pricing',
    docs: 'Docs',
    blog: 'Blog',
  },
  footer: {
    terms: 'Terms',
    privacy: 'Privacy',
    dpa: 'DPA',
    contact: 'Contact',
  },
  tagline:
    'Reliable, controlled WhatsApp messaging infrastructure: durable queues, paced sending, health monitoring, and safe pause and resume.',
} as const;

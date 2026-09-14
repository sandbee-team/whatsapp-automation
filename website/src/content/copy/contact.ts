/**
 * contact.ts (P29 U4b) - copy for the /contact/ page and the lead form.
 * Every user-facing string lives here; the component and the page never
 * hand-roll product copy. No product-name tokens (the pacing/fan-out
 * feature names are never spelled here), no capacity number, no price
 * figure - honest, plain copy only (core invariant 6).
 */
export const CONTACT_COPY = {
  heading: 'Contact',
  intro: 'Tell us about your use case and we will reply by email. Prices are shared on request.',
  fields: {
    name: { label: 'Name', placeholder: 'Your name' },
    email: { label: 'Email', placeholder: 'you@example.com' },
    company: { label: 'Company (optional)', placeholder: 'Company name' },
    phone: { label: 'Phone (optional)', placeholder: '+1 555 0100' },
    message: { label: 'Message', placeholder: 'What are you looking to do?' },
  },
  submitLabel: 'Send',
  submittingLabel: 'Sending',
  success: 'Thanks — we have your details and will reply by email.',
  error: 'We could not send that. Please try again in a moment.',
  rateLimited: 'Too many requests from your connection right now. Please try again later.',
  privacyNote:
    'We store what you type here, the page you came from, and an irreversible hash of your IP address — never the address itself. See the privacy notice.',
  privacyLinkLabel: 'privacy notice',
} as const;

/**
 * pricing.ts (P29 U2) - copy for the /pricing/ page. "contact-us" is the
 * only pricing mode this release ships: no price table, no capacity number,
 * no currency figure anywhere - see the CTA below.
 */
export const PRICING_COPY = {
  heading: 'Pricing',
  intro: 'Prices are shared on request.',
  howBillingWorks: {
    heading: 'How billing works',
    paragraphs: [
      'Sending is prepaid from a wallet and charged per message when WhatsApp accepts the message.',
      'A message that never reaches "sent" is never charged.',
      'Once WhatsApp has acknowledged a message it is charged and not refunded, even if it is later unread, the recipient has blocked you, or the number turns out not to be on WhatsApp - WhatsApp gives no reliable after-acknowledgement undeliverable signal and we will not pretend otherwise.',
      'Top-ups are manual (UPI or bank transfer with a UTR, approved by a person, same business day at best).',
    ],
  },
  cta: {
    label: 'Contact us',
    href: '/contact/',
  },
} as const;

/**
 * home.ts (P29 U2) - copy for the home page. Honest bullets only: no
 * capacity number, no price, no delivery-speed promise, no comparison
 * against WhatsApp's own limits (safety-compliance).
 */
export const HOME_COPY = {
  hero: {
    heading: 'Reliable, controlled WhatsApp messaging infrastructure',
    subline:
      'Durable queues, paced sending, health monitoring, and safe pause and resume - built so nothing you send is ever lost.',
    ctaPrimary: 'See pricing',
    ctaSecondary: 'Read the docs',
  },
  whatItIsNot: {
    heading: 'What it is, and what it is not',
    bullets: [
      'It is infrastructure for sending WhatsApp messages from your own connected number, one durable job at a time.',
      "It is not a way to bypass WhatsApp's own rules. WhatsApp can restrict any account for its own reasons - recipient reports, message content, and account reputation among them - and no sending pace can prevent that.",
      "It watches your account's health signals and stops sending on a number the moment WhatsApp signals a restriction, so a bad signal never compounds.",
    ],
  },
  howItWorks: {
    heading: 'How it works',
    steps: [
      'Link a number as a linked device by scanning a QR code.',
      'Import your contacts with a consent attestation.',
      "Send paced messages and watch the number's health in real time.",
    ],
  },
  ctas: {
    pricing: 'See pricing',
    docs: 'Read the docs',
  },
} as const;

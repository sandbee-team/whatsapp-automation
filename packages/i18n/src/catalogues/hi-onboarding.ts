import type { Catalogue } from './catalogue-type.js';

/**
 * Hindi strings for the 2026-09-08 onboarding + auth layout refresh; mirrors
 * en-onboarding.ts key for key.
 */
export const hiOnboarding = {
  'onboarding.authLayout.footerLine': 'जिम्मेदारी से भेजने वाली टीमों के लिए बनाया गया।',
  'onboarding.wizard.railEyebrow': 'वर्कस्पेस सेटअप',
  'onboarding.wizard.stepOf': 'चरण {current} / {total}',
  'onboarding.wizard.reassurance': 'आप इसे बाद में सेटिंग्स में कभी भी बदल सकते हैं।',
  'onboarding.wizard.doneRingLabel': 'सेटअप पूर्ण',
  'onboarding.wizard.stepDescription.verifyEmail': 'पुष्टि करें कि यह वाकई आप हैं।',
  'onboarding.wizard.stepDescription.timezone': 'शेड्यूलिंग और पेसिंग विंडो के लिए उपयोग होता है।',
  'onboarding.wizard.stepDescription.pacingProfile': 'अपनी डिफ़ॉल्ट भेजने की गति देखें।',
  'onboarding.wizard.stepDescription.consent': 'अपनी भेजने की जिम्मेदारियों की पुष्टि करें।',
  'onboarding.wizard.stepDescription.connect': 'अपना व्हाट्सएप नंबर लिंक करें।',
} as const satisfies Catalogue;

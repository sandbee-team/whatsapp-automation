import type { Catalogue } from './catalogue-type.js';

/** Hindi strings for the 2026-09-08 numbers screen + instance card refresh; mirrors en-numbers.ts key for key. */
export const hiNumbers = {
  'instances.summary.connected': 'कनेक्टेड',
  'instances.summary.needsAttention': 'ध्यान चाहिए',
  'instances.summary.parked': 'पार्क किए गए',

  'instances.card.stats.queued': 'कतार में',
  'instances.card.stats.nextSend': 'अगला भेजना',
  'instances.card.stats.window': 'समय-सीमा',

  'instances.connect.limitOrNoPlan.title': 'यह वर्कस्पेस अभी नंबर नहीं जोड़ सकता',
  'instances.connect.limitOrNoPlan.body':
    'आपके वर्कस्पेस में कोई प्लान असाइन नहीं है, या इसके प्लान की अनुमति वाले सभी नंबर इस्तेमाल हो चुके हैं। अपने एडमिनिस्ट्रेटर से प्लान असाइन या अपग्रेड करने के लिए कहें, फिर दोबारा प्रयास करें।',
  'instances.connect.limitOrNoPlan.help': 'कुछ भी खोया नहीं है। कोई नंबर नहीं बनाया गया।',
} as const satisfies Catalogue;

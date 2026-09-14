import type { Catalogue } from './catalogue-type.js';

/** Hindi strings for the go-live U5 tenant API keys settings screen (key set identical to en-api-keys.ts). */
export const hiApiKeys = {
  'apiKeys.title': 'API कीज़',
  'apiKeys.subtitle':
    'अपने खुद के कोड से मैसेजिंग API कॉल करने के लिए API की का उपयोग करें। हर रिक्वेस्ट में Idempotency-Key हेडर भी होना चाहिए।',
  'apiKeys.empty.title': 'अभी तक कोई API की नहीं बनाई गई',
  'apiKeys.empty.body': 'अपने खुद के कोड से मैसेजिंग API कॉल करने के लिए एक की बनाएं।',
  'apiKeys.addButton': 'की बनाएं',
  'apiKeys.loading': 'लोड हो रहा है…',
  'apiKeys.error': 'कुछ गलत हो गया। कृपया फिर से प्रयास करें।',
  'apiKeys.list.activeBadge': 'सक्रिय',
  'apiKeys.list.revokedBadge': 'रद्द',
  'apiKeys.list.createdLabel': 'बनाई गई',
  'apiKeys.list.lastUsedLabel': 'आखिरी बार उपयोग',
  'apiKeys.list.neverUsed': 'कभी नहीं',
  'apiKeys.list.revokedAtLabel': 'रद्द की गई',
  'apiKeys.list.revokeButton': 'रद्द करें',
  'apiKeys.list.revokeConfirmPrompt': 'यह की रद्द करें? इसे वापस नहीं लाया जा सकता।',
  'apiKeys.list.revokeConfirmButton': 'रद्द करने की पुष्टि करें',
  'apiKeys.list.revokeCancelButton': 'रद्द करें',
  'apiKeys.list.revokeError': 'यह की रद्द नहीं की जा सकी। कृपया फिर से प्रयास करें।',

  'apiKeys.form.title': 'एक API की बनाएं',
  'apiKeys.form.nameLabel': 'की का नाम',
  'apiKeys.form.nameDescription':
    'अपनी कीज़ को पहचानने में मदद के लिए एक लेबल, जैसे इसे उपयोग करने वाला ऐप।',
  'apiKeys.form.namePlaceholder': 'ऑर्डर कन्फर्मेशन सर्विस',
  'apiKeys.form.submitButton': 'की बनाएं',
  'apiKeys.form.genericError': 'कुछ गलत हो गया। कृपया फिर से प्रयास करें।',
  'apiKeys.form.nameRequired': '1 से 64 अक्षरों के बीच एक नाम दर्ज करें।',

  'apiKeys.keyOnce.title': 'अभी इस API की को सुरक्षित करें',
  'apiKeys.keyOnce.body':
    'यह की एक बार दिखाई जाती है और दोबारा नहीं दिखाई जाएगी। इस डायलॉग को बंद करने से पहले इसे सुरक्षित रखें।',
  'apiKeys.keyOnce.copyButton': 'की कॉपी करें',
  'apiKeys.keyOnce.copiedLabel': 'कॉपी हो गया',
  'apiKeys.keyOnce.doneButton': 'हो गया',
} as const satisfies Catalogue;

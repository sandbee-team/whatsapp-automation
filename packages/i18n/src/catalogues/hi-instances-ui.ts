import type { Catalogue } from './catalogue-type.js';

/** Hindi strings for the P26b U3 dashboard and instances (key set identical to en-instances-ui.ts). */
export const hiInstancesUi = {
  'dashboard.checklist.title': 'शुरुआत करें',
  'dashboard.checklist.connect.title': 'एक नंबर कनेक्ट करें',
  'dashboard.checklist.connect.body': 'भेजना शुरू करने के लिए एक WhatsApp नंबर लिंक करें।',
  'dashboard.checklist.connect.cta': 'नंबर कनेक्ट करें',
  'dashboard.checklist.sendTest.title': 'अपना पहला संदेश भेजें',
  'dashboard.checklist.sendTest.body': 'किसी जुड़े नंबर से संदेश भेजकर देखें।',
  'dashboard.checklist.sendTest.cta': 'नंबरों पर जाएं',
  'dashboard.checklist.addFunds.title': 'राशि जोड़ें',
  'dashboard.checklist.addFunds.body': 'भेजना जारी रखने के लिए अपने वॉलेट में राशि जोड़ें।',
  'dashboard.checklist.addFunds.cta': 'वॉलेट पर जाएं',
  'dashboard.checklist.done': 'पूर्ण',
  'dashboard.checklist.todo': 'शेष',
  'dashboard.numbers.title': 'आपके नंबर',
  'dashboard.numbers.viewAll': 'सभी देखें',
  'dashboard.activity.title': 'हाल की गतिविधि',
  'dashboard.activity.empty': 'अभी कोई हाल की गतिविधि नहीं है।',
  'dashboard.activity.error': 'कुछ गड़बड़ हो गई। कृपया फिर से प्रयास करें।',
  'dashboard.summary.error': 'आपका डैशबोर्ड लोड करने में समस्या हुई।',
  'dashboard.spentToday': 'आज खर्च हुआ',

  'instances.numbers.grid.empty.title': 'अभी तक कोई नंबर कनेक्ट नहीं है',
  'instances.numbers.grid.empty.body':
    'संदेश भेजने और प्राप्त करने के लिए एक WhatsApp नंबर कनेक्ट करें।',
  'instances.numbers.grid.error.title': 'आपके नंबर लोड नहीं हो सके',
  'instances.numbers.grid.error.body': 'कुछ गड़बड़ हो गई। कृपया फिर से प्रयास करें।',

  'instances.switcher.allNumbers': 'सभी नंबर',
  'instances.switcher.triggerLabel': 'नंबर बदलें',

  'instances.detail.breadcrumbLabel': 'नंबर',
  'instances.detail.pause': 'रोकें',
  'instances.detail.pauseConfirmTitle': 'इस नंबर को रोकें?',
  'instances.detail.pauseConfirmBody':
    'कतार में मौजूद संदेश कतार में ही रहेंगे। जब आप इस नंबर को फिर से ऑनलाइन लाएंगे तभी भेजना फिर शुरू होगा।',
  'instances.detail.resume': 'फिर से शुरू करें',
  'instances.detail.resumeConfirmTitle': 'इस नंबर को फिर से शुरू करें?',
  'instances.detail.resumeConfirmBody': 'यह नंबर कतार में मौजूद संदेश फिर से भेजना शुरू करेगा।',
  'instances.detail.reconnect': 'फिर से कनेक्ट करें',
  'instances.detail.reconnectGoToNumbers': 'फिर से कनेक्ट करने के लिए नंबरों पर जाएं',
  'instances.detail.why': 'क्यों?',
  'instances.detail.pauseSuccess': 'नंबर रोक दिया गया।',
  'instances.detail.pauseError': 'यह नंबर रोका नहीं जा सका। कृपया फिर से प्रयास करें।',
  'instances.detail.resumeSuccess': 'नंबर फिर से ऑनलाइन है।',
  'instances.detail.resumeError': 'यह नंबर ऑनलाइन नहीं लाया जा सका। कृपया फिर से प्रयास करें।',
  'instances.detail.delete': 'हटाएं',
  'instances.detail.deleteConfirmTitle': 'इस नंबर को हटाएं?',
  'instances.detail.deleteConfirmBody':
    'इससे यह नंबर आपके वर्कस्पेस से हट जाएगा और आपके प्लान में एक नए नंबर के लिए जगह खाली हो ' +
    'जाएगी। इसका संदेश और कतार इतिहास मिटाया नहीं जाता, सुरक्षित रहता है। इसे यहां से वापस नहीं ' +
    'लिया जा सकता।',
  'instances.detail.deleteSuccess': 'नंबर हटा दिया गया।',
  'instances.detail.deleteError': 'यह नंबर हटाया नहीं जा सका। कृपया फिर से प्रयास करें।',
  'instances.detail.tabs.overview': 'अवलोकन',
  'instances.detail.tabs.health': 'स्वास्थ्य',
  'instances.detail.tabs.queue': 'कतार',
  'instances.detail.overview.todaySent': 'आज भेजे गए',
  'instances.detail.overview.newConversations': 'नई बातचीत',
  'instances.detail.overview.queueDepth': 'कतार की गहराई',
  'instances.detail.overview.oldestQueuedAge': 'सबसे पुराना कतारबद्ध (सेकंड)',
  'instances.detail.overview.sendingWindow': 'भेजने की समय-सीमा',
  'instances.detail.overview.nextSend': 'अगला भेजना',
  'instances.detail.queue.waiting': 'प्रतीक्षारत',
  'instances.detail.queue.sentToday': 'आज भेजे गए',
  'instances.detail.queue.failedToday': 'आज विफल',
  'instances.detail.error.title': 'यह नंबर लोड नहीं हो सका',
  'instances.detail.error.body': 'कुछ गड़बड़ हो गई। कृपया फिर से प्रयास करें।',

  'instances.connect.mfaEnrol.body':
    'नंबर कनेक्ट करने से पहले टू-फैक्टर ऑथेंटिकेशन सेट करना आवश्यक है।',
  'instances.connect.mfaEnrol.button': 'टू-फैक्टर सेट करें',
  'instances.connect.mfaVerify.body':
    'आपका मौजूदा साइन-इन टू-फैक्टर से सत्यापित नहीं है। जारी रखने के लिए फिर से साइन इन करें।',
  'instances.connect.mfaVerify.button': 'फिर से साइन इन करें',
} as const satisfies Catalogue;

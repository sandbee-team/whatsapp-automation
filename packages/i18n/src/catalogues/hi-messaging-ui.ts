import type { Catalogue } from './catalogue-type.js';

/** Hindi strings for the P26b U4 messages, unresolved and fan-out screens (key set identical to en-messaging-ui.ts). */
export const hiMessagingUi = {
  'messages.compose.accountPicker.label': 'भेजने वाला नंबर',
  'messages.compose.accountPicker.placeholder': 'एक कनेक्टेड नंबर चुनें',
  'messages.compose.accountPicker.disabledHint': 'भेजने के लिए तैयार नहीं',
  'messages.compose.accountPicker.empty': 'अभी कोई कनेक्टेड नंबर नहीं है।',
  'messages.compose.previewTitle': 'पूर्वावलोकन',
  'messages.compose.previewEmpty': 'टाइप करते समय आपका मैसेज पूर्वावलोकन यहाँ दिखेगा।',
  'messages.compose.recipientPicker.searchLabel': 'संपर्क खोजें',
  'messages.compose.charCount': '{count}/{max}',

  'messages.compose.captionLabel': 'कैप्शन (वैकल्पिक)',
  'messages.compose.attachment.label': 'अटैचमेंट (वैकल्पिक)',
  'messages.compose.attachment.hint': 'एक इमेज या डॉक्यूमेंट अटैच करें।',
  'messages.compose.attachment.caps':
    'इमेज अधिकतम {imageMb} MB तक, डॉक्यूमेंट अधिकतम {documentMb} MB तक।',
  'messages.compose.attachment.uploading': 'अटैचमेंट अपलोड हो रहा है',
  'messages.compose.attachment.remove': 'अटैचमेंट हटाएं',
  'messages.compose.attachment.errorTooLarge':
    'यह फ़ाइल बहुत बड़ी है। कृपया छोटी इमेज या डॉक्यूमेंट चुनें।',
  'messages.compose.attachment.errorUnsupportedType':
    'यह फ़ाइल प्रकार समर्थित नहीं है। कृपया समर्थित फॉर्मेट में इमेज या डॉक्यूमेंट चुनें।',
  'messages.compose.attachment.errorUploadFailed':
    'अटैचमेंट अपलोड नहीं हो सका। कृपया फिर से प्रयास करें।',
  'messages.compose.attachment.errorUploadInProgress':
    'अभी नहीं भेज सकते - अटैचमेंट अभी भी अपलोड हो रहा है।',

  'unresolved.explainer.title': 'अनसुलझे भेजे गए संदेश कहाँ से आते हैं',
  'unresolved.explainer.body':
    'जब हम पक्के तौर पर यह पुष्टि नहीं कर पाते कि WhatsApp ने संदेश डिलीवर किया या नहीं - जैसे ' +
    'रीकनेक्ट के बाद - तो वह संदेश यहाँ आता है। इसकी अनसुलझी भेजी गई सूची देखने और कार्रवाई करने ' +
    'के लिए नीचे नंबर खोजें; डैशबोर्ड की गतिविधि फ़ीड पर भी संबंधित सूचनाएं देखी जा सकती हैं।',
  'unresolved.explainer.dashboardLink': 'डैशबोर्ड गतिविधि पर जाएं',
  'unresolved.unavailable.title': 'अभी दिखाने के लिए कुछ नहीं',
  'unresolved.unavailable.body':
    'इसकी अनसुलझी भेजी गई सूची जांचने के लिए ऊपर एक नंबर दर्ज करें। यह सूची केवल वे संदेश दिखाती ' +
    'है जिनकी हम पुष्टि नहीं कर पाए - यह सामान्य संदेश इतिहास कभी नहीं है।',
  'unresolved.accountPicker.label': 'नंबर',
  'unresolved.accountPicker.placeholder': 'इंस्टेंस id',
  'unresolved.toast.retrySuccess': 'फिर से भेजने के लिए कतारबद्ध किया गया।',
  'unresolved.toast.discardSuccess': 'भेजना छोड़ दिया गया।',
  'unresolved.toast.actionError': 'कुछ गलत हो गया। कृपया फिर से प्रयास करें।',

  'broadcasts.wizard.step.audience': 'ऑडियंस',
  'broadcasts.wizard.step.message': 'मैसेज',
  'broadcasts.wizard.step.schedule': 'शेड्यूल',
  'broadcasts.wizard.step.review': 'समीक्षा और प्रीफ़्लाइट',
  'broadcasts.wizard.stepDone': 'पूर्ण',
  'broadcasts.wizard.stepCurrent': 'मौजूदा चरण',
  'broadcasts.wizard.stepUpcoming': 'अभी शुरू नहीं हुआ',
  'broadcasts.wizard.next': 'आगे',
  'broadcasts.wizard.back': 'पीछे',
  'broadcasts.wizard.timezoneLabel': 'समय आपके डिवाइस के टाइमज़ोन में दिखाए गए हैं',

  'broadcasts.list.actions.label': 'कार्रवाइयां',
  'broadcasts.list.actions.open': 'खोलें',
  'broadcasts.list.actions.pause': 'रोकें',
  'broadcasts.list.actions.resume': 'फिर से शुरू करें',
  'broadcasts.list.actions.cancel': 'रद्द करें',
  'broadcasts.list.col.actions': 'कार्रवाइयां',
  'broadcasts.list.toast.pauseSuccess': 'भेजना रोका गया।',
  'broadcasts.list.toast.resumeSuccess': 'भेजना फिर से शुरू हुआ।',
  'broadcasts.list.toast.cancelSuccess': 'भेजना रद्द किया गया।',
  'broadcasts.list.toast.actionError': 'कुछ गड़बड़ हो गई। ब्रॉडकास्ट में कोई बदलाव नहीं हुआ।',

  'notifications.bell.markAllReadError':
    'सभी को पढ़ा हुआ चिह्नित नहीं किया जा सका। कृपया फिर से प्रयास करें।',
} as const satisfies Catalogue;

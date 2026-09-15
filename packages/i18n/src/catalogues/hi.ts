import type { Catalogue } from './catalogue-type.js';
import { en } from './en.js';
import { hiContacts } from './hi-contacts.js';
import { hiBroadcasts } from './hi-broadcasts.js';
import { hiGroups } from './hi-groups.js';
import { hiShell } from './hi-shell.js';
import { hiInstancesUi } from './hi-instances-ui.js';
import { hiMessagingUi } from './hi-messaging-ui.js';
import { hiDataUi } from './hi-data-ui.js';
import { hiDashboard } from './hi-dashboard.js';
import { hiOnboarding } from './hi-onboarding.js';
import { hiShellRefresh } from './hi-shell-refresh.js';
import { hiNumbers } from './hi-numbers.js';
import { hiAdmin } from './hi-admin.js';
import { hiApiKeys } from './hi-api-keys.js';

/**
 * Hindi catalogue (P05 step 2) - real Devanagari Hindi, not
 * transliteration. Must carry the identical key set as `en.ts` (see
 * `catalogue-parity.test.ts`). HONEST COPY ONLY: no delivery-speed or
 * restriction-avoidance claims anywhere (core invariant 6) - see
 * `@wp/domain`'s `BANNED_CLAIMS` for the full list this file must never
 * contain, in any language.
 *
 * `instances.card.safeModeStatus`/`instances.card.safeModeDisclaimer` keep
 * the brand term "Safe Mode" in English (same Hinglish convention as
 * "Linked Devices" elsewhere in this file) - `scripts/check-copy.ts`'s
 * co-presence clause matches the literal English token regardless of
 * surrounding language, so this file's disclaimer value must carry the
 * verbatim English disclaimer text too (`PACING_COPY`'s own precedent: no
 * Hinglish translation exists for that string yet).
 */
const SAFE_MODE_DISCLAIMER_LITERAL = `Safe Mode paces your sending and watches your account's real signals. It reduces the risk of triggering spam or rate-limit signals from sending too fast or too cold. It cannot prevent or guarantee against WhatsApp restrictions — bans also come from recipient reports, message content and account reputation, which no sender-side pacing can control.`;

export const hi = {
  'app.name': en['app.name'],

  'nav.dashboard': 'डैशबोर्ड',
  'nav.instances': 'नंबर',
  'nav.unresolved': 'अनसुलझे संदेश',
  'nav.logout': 'लॉग आउट',
  'nav.language': 'भाषा',

  'realtime.live': 'लाइव',
  'realtime.reconnecting': 'पुनः कनेक्ट हो रहा है…',
  'realtime.offline': 'ऑफ़लाइन',

  'dashboard.title': 'डैशबोर्ड',
  'dashboard.subtitle': 'आपके जुड़े हुए व्हाट्सऐप नंबरों का विवरण।',
  'dashboard.connectedNumbers': 'जुड़े हुए नंबर',
  'dashboard.queued': 'कतार में',
  'dashboard.sent': 'भेजे गए',
  'dashboard.empty.title': 'अभी तक कोई नंबर नहीं जोड़ा गया',
  'dashboard.empty.body':
    'आपके पास 0 जुड़े हुए नंबर, 0 कतार में संदेश, और 0 भेजे गए संदेश हैं। शुरू करने के लिए एक नंबर जोड़ें।',
  'dashboard.empty.cta': 'नंबर जोड़ें',

  'common.loading': 'लोड हो रहा है…',
  'common.retry': 'पुनः प्रयास करें',
  'common.error.generic': 'कुछ गलत हो गया। कृपया फिर से प्रयास करें।',
  'common.close': 'बंद करें',

  'auth.recovery.title': 'खाता पुनर्प्राप्ति',
  'auth.recovery.code': 'पुनर्प्राप्ति कोड',
  'auth.recovery.submit': 'जारी रखें',
  'auth.recovery.hint': '{name} के लिए पुनर्प्राप्ति कोड दर्ज करें।',
  'auth.recovery.invalid': 'यह पुनर्प्राप्ति कोड मान्य नहीं है।',
  'auth.recovery.link': 'अपना खाता पुनर्प्राप्त करने में मदद चाहिए?',

  'instances.connect.title': 'एक नंबर जोड़ें',
  'instances.connect.description':
    'QR कोड या 8-अक्षर के पेयरिंग कोड से किसी व्हाट्सऐप नंबर को WP से जोड़ें।',
  'instances.connect.labelInput': 'लेबल',
  'instances.connect.labelInput.description': 'इस नंबर को दूसरों से अलग पहचानने के लिए एक नाम।',
  'instances.connect.labelInput.placeholder': 'जैसे सेल्स टीम',
  'instances.connect.createButton': 'जारी रखें',
  'instances.connect.methodTitle': 'जोड़ने का तरीका चुनें',
  'instances.connect.methodQr': 'QR कोड स्कैन करें',
  'instances.connect.methodCode': '8-अक्षर का कोड दर्ज करें',
  'instances.connect.phoneInput': 'फ़ोन नंबर',
  'instances.connect.phoneInput.description': 'देश कोड सहित लिखें, जैसे +91XXXXXXXXXX।',
  'instances.connect.startButton': 'शुरू करें',
  'instances.connect.genericError': 'कुछ गलत हो गया। कृपया फिर से प्रयास करें।',

  'instances.connect.qr.title': 'यह QR कोड स्कैन करें',
  'instances.connect.qr.body':
    'अपने फ़ोन पर व्हाट्सऐप खोलें, Linked Devices में जाएं, और स्कैन करें।',
  'instances.connect.qr.attemptsLeft': '{count} स्कैन शेष',
  'instances.connect.qr.expired': 'यह कोड समय सीमा समाप्त हो चुका है।',
  'instances.connect.qr.refreshButton': 'नया कोड जनरेट करें',

  'instances.connect.code.title': 'यह कोड व्हाट्सऐप में दर्ज करें',
  'instances.connect.code.body':
    'अपने फ़ोन पर व्हाट्सऐप खोलें, Linked Devices में जाएं, Link with phone number चुनें, और यह कोड दर्ज करें।',
  'instances.connect.code.attemptsLeft': '{count} प्रयास शेष',
  'instances.connect.code.expired': 'यह कोड समय सीमा समाप्त हो चुका है।',
  'instances.connect.code.refreshButton': 'नया कोड जनरेट करें',

  'instances.connect.linking.title': 'पूरा किया जा रहा है',
  'instances.connect.linking.body': 'आपके फ़ोन पर व्हाट्सऐप से लिंक की पुष्टि का इंतज़ार है।',

  'instances.connect.connected.title': 'जुड़ गया',
  'instances.connect.connected.body': 'यह नंबर जुड़ा हुआ और उपयोग के लिए तैयार है।',

  'instances.connect.parked.title': 'पार्क किया गया',
  'instances.connect.parked.onlineButton': 'ऑनलाइन लाएं',
  'instances.connect.parked.parkButton': 'इस नंबर को पार्क करें',

  'instances.connect.noFreeSlot.title': 'कोई खाली स्लॉट उपलब्ध नहीं',
  'instances.connect.noFreeSlot.body':
    'आपके सभी जुड़े स्लॉट उपयोग में हैं। एक स्लॉट खाली करने के लिए नीचे दिए गए किसी नंबर को पार्क करें।',
  'instances.connect.noFreeSlot.parkInsteadButton': 'इसके बजाय इसे पार्क करें',

  'instances.connect.registeredLimitReached':
    'आप जितने नंबर रजिस्टर कर सकते हैं उस सीमा तक पहुंच गए हैं। और नंबर जोड़ने के लिए सहायता टीम से संपर्क करें।',
  'instances.connect.invalidState': 'यह नंबर अभी नहीं जोड़ा जा सकता। कृपया फिर से प्रयास करें।',

  'instances.list.title': 'नंबर',
  'instances.list.subtitle': 'अपने व्हाट्सऐप नंबर जोड़ें और प्रबंधित करें।',
  'instances.list.connectCta': 'एक नंबर जोड़ें',

  'messages.compose.title': 'संदेश भेजें',
  'messages.compose.accountLabel': 'भेजने वाला नंबर',
  'messages.compose.accountDescription': 'जुड़े हुए नंबर की इंस्टेंस आईडी।',
  'messages.compose.accountPlaceholder': 'इंस्टेंस आईडी',
  'messages.compose.recipientLabel': 'प्राप्तकर्ता',
  'messages.compose.recipientDescription': '+कंट्री कोड प्रारूप में एक फ़ोन नंबर, या एक समूह।',
  'messages.compose.recipientPlaceholder': '+919876543210',
  'messages.compose.bodyLabel': 'संदेश',
  'messages.compose.bodyPlaceholder': 'अपना संदेश लिखें',
  'messages.compose.sendButton': 'भेजें',
  'messages.compose.errorIdempotencyKeyReused':
    'यह संदेश पहले ही अलग विवरण के साथ सबमिट किया जा चुका है। कृपया एक नया संदेश शुरू करें।',
  'messages.compose.errorInstanceUnlinked':
    'यह नंबर अभी तक जोड़ा नहीं गया है। भेजने से पहले इसे कनेक्ट करें।',
  'messages.compose.errorGeneric': 'कुछ गलत हो गया। कृपया फिर से प्रयास करें।',
  'messages.status.sent': 'भेजा गया',

  'unresolved.panel.title': 'अनसुलझे संदेश',
  'unresolved.panel.empty': 'इस नंबर के लिए कोई अनसुलझा संदेश नहीं है।',
  'unresolved.panel.error': 'कुछ गलत हो गया। कृपया फिर से प्रयास करें।',

  'pacing.fanoutBanner.title': 'एक जैसे दिख रहे मैसेज की पुष्टि करें',
  'pacing.fanoutBanner.body':
    'यह बिल्कुल एक जैसा मैसेज आज {count} प्राप्तकर्ताओं को जा रहा है। यह कतार में सुरक्षित और रुका हुआ है ताकि आप पुष्टि कर सकें कि यह जानबूझकर किया गया है - कुछ भी विफल या खोया नहीं है।',
  'pacing.fanoutBanner.confirmButton': 'हां, यह {count} प्राप्तकर्ताओं के लिए जानबूझकर है',
  'pacing.fanoutBanner.editHint': 'या अगर यह इरादा नहीं था तो कैंपेन संपादित करें।',
  'pacing.fanoutBanner.error': 'कुछ गलत हो गया। कृपया फिर से प्रयास करें।',

  'nav.settings': 'सेटिंग्स',

  'webhooks.title': 'वेबहुक एंडपॉइंट',
  'webhooks.subtitle':
    'डिलीवरी कम-से-कम एक बार होती है। आपके एंडपॉइंट को एक ही इवेंट एक से अधिक बार मिल सकता है - X-WP-Event-Id हेडर से डुप्लीकेट हटाएं।',
  'webhooks.empty.title': 'अभी तक कोई वेबहुक एंडपॉइंट नहीं जोड़ा गया',
  'webhooks.empty.body': 'स्टेट हिंट के रूप में इवेंट सूचनाएं पाने के लिए एक एंडपॉइंट जोड़ें।',
  'webhooks.addButton': 'एंडपॉइंट जोड़ें',
  'webhooks.loading': 'लोड हो रहा है…',
  'webhooks.error': 'कुछ गलत हो गया। कृपया फिर से प्रयास करें।',
  'webhooks.list.disabledBadge': 'निष्क्रिय',
  'webhooks.list.enabledBadge': 'सक्रिय',
  'webhooks.list.testButton': 'टेस्ट इवेंट भेजें',
  'webhooks.list.testSending': 'भेजा जा रहा है…',
  'webhooks.list.testResultSuccess': 'टेस्ट इवेंट डिलीवरी के लिए क्यू में डाल दिया गया।',
  'webhooks.list.testResultError':
    'टेस्ट इवेंट क्यू में नहीं डाला जा सका। कृपया फिर से प्रयास करें।',
  'webhooks.list.deleteButton': 'हटाएं',
  'webhooks.list.deleteConfirmPrompt': 'यह एंडपॉइंट हटाएं? इसे वापस नहीं लाया जा सकता।',
  'webhooks.list.deleteConfirmButton': 'हटाने की पुष्टि करें',
  'webhooks.list.deleteCancelButton': 'रद्द करें',
  'webhooks.list.deleteError': 'यह एंडपॉइंट हटाया नहीं जा सका। कृपया फिर से प्रयास करें।',

  'webhooks.form.title': 'एक वेबहुक एंडपॉइंट जोड़ें',
  'webhooks.form.urlLabel': 'एंडपॉइंट URL',
  'webhooks.form.urlDescription': 'यह एक HTTPS URL होना चाहिए जो POST रिक्वेस्ट प्राप्त कर सके।',
  'webhooks.form.urlPlaceholder': 'https://example.com/webhooks/wp',
  'webhooks.form.eventsLabel': 'भेजे जाने वाले इवेंट',
  'webhooks.form.deliveryNotice':
    'डिलीवरी कम-से-कम एक बार होती है: आपके एंडपॉइंट को एक ही इवेंट एक से अधिक बार मिल सकता है। हर रिक्वेस्ट पर X-WP-Event-Id हेडर से डुप्लीकेट हटाएं।',
  'webhooks.form.sseHint':
    'ऐप के भीतर रीयलटाइम कनेक्शन एक स्टेट हिंट है, इवेंट लॉग नहीं - यह पैनल को बताता है कि कुछ बदला है ताकि वह फिर से डेटा ले सके, और यह कभी भी वेबहुक डिलीवरी की जगह नहीं लेता।',
  'webhooks.form.submitButton': 'एंडपॉइंट बनाएं',
  'webhooks.form.genericError': 'कुछ गलत हो गया। कृपया फिर से प्रयास करें।',
  'webhooks.form.urlRequired': 'एक मान्य HTTPS एंडपॉइंट URL दर्ज करें।',
  'webhooks.form.eventsRequired': 'कम से कम एक इवेंट चुनें।',

  'webhooks.secretOnce.title': 'अभी इस सिग्निंग सीक्रेट को सुरक्षित करें',
  'webhooks.secretOnce.body':
    'यह सीक्रेट एक बार दिखाया जाता है और दोबारा नहीं दिखाया जाएगा। इस डायलॉग को बंद करने से पहले इसे सुरक्षित रखें।',
  'webhooks.secretOnce.copyButton': 'सीक्रेट कॉपी करें',
  'webhooks.secretOnce.copiedLabel': 'कॉपी हो गया',
  'webhooks.secretOnce.doneButton': 'हो गया',

  'webhooks.disabledBanner.title': 'यह एंडपॉइंट निष्क्रिय है',
  'webhooks.disabledBanner.consecutiveFailures':
    'लगातार 20 डिलीवरी विफलताओं के बाद इसे निष्क्रिय किया गया। एंडपॉइंट ठीक करें, फिर डिलीवरी फिर से शुरू करने के लिए इसे सक्रिय करें।',
  'webhooks.disabledBanner.generic': 'यह एंडपॉइंट फ़िलहाल निष्क्रिय है।',
  'webhooks.disabledBanner.reEnableButton': 'फिर से सक्रिय करें',
  'webhooks.disabledBanner.reEnableError':
    'यह एंडपॉइंट फिर से सक्रिय नहीं किया जा सका। कृपया फिर से प्रयास करें।',

  'notifications.bell.label': 'सूचनाएं',
  'notifications.bell.title': 'सूचनाएं',
  'notifications.bell.empty': 'अभी तक कोई सूचना नहीं है।',
  'notifications.bell.error': 'कुछ गलत हो गया। कृपया फिर से प्रयास करें।',
  'notifications.bell.markAllRead': 'सभी को पढ़ा हुआ चिह्नित करें',
  'notifications.bell.markRead': 'पढ़ा हुआ चिह्नित करें',
  'notifications.bell.unreadBadge': 'अपठित',
  'notifications.bell.loadMore': 'और लोड करें',
  'notifications.bell.markReadError':
    'इसे पढ़ा हुआ चिह्नित नहीं किया जा सका। कृपया फिर से प्रयास करें।',
  'notifications.banner.criticalBadge': 'कार्रवाई आवश्यक',
  'notifications.banner.dismiss': 'पढ़ा हुआ चिह्नित करें',

  'wallet.empty.banner':
    'भेजना रुका हुआ है — आपका वॉलेट खाली है। {queued} संदेश प्रतीक्षा में हैं और फंड जोड़ते ही भेजे ' +
    'जाएंगे।',
  'wallet.low.banner': 'आपका वॉलेट बैलेंस कम हो रहा है। रुकावट से बचने के लिए जल्द ही फंड जोड़ें।',
  'wallet.resume.afterTopup':
    'फंड जोड़ते ही भेजना अपने आप फिर शुरू हो जाता है — ज़्यादातर नंबर लगभग एक मिनट में फिर शुरू हो ' +
    'जाते हैं (छूटे संकेत को पकड़ने वाली सुरक्षा जांच अपने अलग चक्र पर चलती है), कभी तुरंत नहीं।',
  'wallet.topup.formTitle': 'फंड जोड़ें',
  'wallet.topup.amountLabel': 'राशि (INR)',
  'wallet.topup.methodLabel': 'भुगतान का तरीका',
  'wallet.topup.utrLabel': 'UTR / संदर्भ संख्या',
  'wallet.topup.submitButton': 'टॉप-अप अनुरोध भेजें',
  'wallet.topup.duplicateError': 'यह संदर्भ संख्या पहले ही भेजी जा चुकी है।',
  'wallet.topup.genericError': 'कुछ गलत हो गया। कृपया फिर से प्रयास करें।',
  'wallet.topup.statusPending': 'समीक्षा लंबित',
  'wallet.topup.statusApproved': 'स्वीकृत',
  'wallet.topup.statusRejected': 'अस्वीकृत',

  'queueStatus.title': 'कतार की स्थिति',
  'queueStatus.waiting': 'प्रतीक्षा में',
  'queueStatus.sentToday': 'आज भेजे गए',
  'queueStatus.failedToday': 'आज विफल',

  'instances.card.safeModeStatus': 'Safe Mode: {profile} · वार्म-अप {tier}/6 (दिन {day})',
  'instances.card.safeModeDisclaimer': SAFE_MODE_DISCLAIMER_LITERAL,
  'instances.card.pacingProfileName': 'Safe Mode (डिफ़ॉल्ट)',
  'instances.card.todayProgress': 'आज {sent}/{cap}',
  'instances.card.newConversations': 'नई बातचीत {count}/{cap}',
  'instances.card.nextSendEarliest': 'अगला भेजना जल्द से जल्द {seconds} सेकंड में',
  'instances.card.sendingWindow': 'भेजने का समय {start}–{end} {tz}',
  'instances.card.notSending':
    'अभी नहीं भेजा जा रहा है। दिखाया गया समय भेजना फिर से शुरू होने का सबसे जल्दी संभव समय है, ' +
    'गारंटीशुदा समय नहीं — यह इस नंबर के स्वस्थ और कनेक्टेड बने रहने पर निर्भर करता है।',
  'instances.card.health': 'हेल्थ {score}/100 {band}',
  'instances.card.healthWhyLink': 'क्यों?',
  'instances.card.queueSummary': 'कतार में {count} · सबसे पुराना {age} · आखिरी भेजा गया {lastSend}',
  'instances.card.queueDepthCapped': '10,000+',
  'instances.card.parked':
    'पार्क किया गया — कनेक्ट नहीं है। पार्क रहते समय इस नंबर पर संदेश प्राप्त नहीं होंगे। इस दौरान ' +
    'आपको भेजे गए संदेश दोबारा कनेक्ट करने के बाद दिखाई न दें, ऐसा हो सकता है। कतार में मौजूद ' +
    'संदेश सुरक्षित हैं और दोबारा कनेक्ट होने पर भेजे जाएंगे।',

  'instances.whyDrawer.title': 'यह हेल्थ स्कोर क्यों?',
  'instances.whyDrawer.signalNotScored':
    'देखा गया लेकिन v1 में स्कोर नहीं किया गया — पारदर्शिता के लिए दिखाया गया, 0 अंक की लागत।',
  'instances.whyDrawer.signalNotEnoughData': 'अभी पर्याप्त डेटा नहीं है — यह कोई दंड नहीं है।',
  'instances.whyDrawer.window': 'विंडो {window}',
  'instances.whyDrawer.evidenceCount': '{count} डेटा पॉइंट',
  'instances.whyDrawer.pointsCost': '{points} अंक',
  'instances.whyDrawer.timelineTitle': 'टाइमलाइन',

  'instances.needsAction.title': 'कार्रवाई आवश्यक',
  'instances.needsAction.openPanelSection': 'नंबर विवरण खोलें',
  'instances.needsAction.reconnect': 'फिर से कनेक्ट करें',
  'instances.needsAction.acknowledge': 'स्वीकार करें',

  'inbound.shed.notice':
    'इस नंबर पर इनकमिंग मैसेज की मात्रा अधिक है — प्रति-नंबर सीमा तक, कुछ आने वाले मैसेज अभी ' +
    'ऑप्ट-आउट कीवर्ड के लिए जांचे नहीं जा रहे हैं। डिलीवरी रसीदें अभी भी दर्ज की जा रही हैं जैसे ही ' +
    'वे आती हैं; WhatsApp इस बात की गारंटी नहीं देता कि हर रसीद किसी लिंक्ड डिवाइस तक पहुंचे। कतार ' +
    'में मौजूद मैसेज सुरक्षित हैं।',

  ...hiContacts,
  ...hiBroadcasts,
  ...hiGroups,
  ...hiShell,
  ...hiInstancesUi,
  ...hiMessagingUi,
  ...hiDataUi,
  ...hiDashboard,
  ...hiOnboarding,
  ...hiShellRefresh,
  ...hiNumbers,
  ...hiAdmin,
  ...hiApiKeys,
} as const satisfies Catalogue;

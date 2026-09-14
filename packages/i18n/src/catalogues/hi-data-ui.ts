import type { Catalogue } from './catalogue-type.js';

/** Hindi strings for the P26b U5 contacts, community-chat, webhooks and wallet screens (key set identical to en-data-ui.ts). */
export const hiDataUi = {
  'wallet.title': 'वॉलेट',
  'wallet.subtitle': 'आपके वर्कस्पेस का बैलेंस, खर्च और टॉप-अप अनुरोध।',
  'wallet.kpi.balance': 'बैलेंस',
  'wallet.kpi.state': 'स्थिति',
  'wallet.kpi.estimatedRemaining': 'अनुमानित शेष संदेश',
  'wallet.kpi.spentToday': 'आज खर्च हुआ',
  'wallet.state.active': 'सक्रिय',
  'wallet.state.low': 'कम बैलेंस',
  'wallet.state.empty': 'खाली',
  'wallet.state.frozen': 'फ़्रीज़',
  'wallet.zeroBalance.title': 'शून्य बैलेंस पर भेजना रुक जाता है',
  'wallet.zeroBalance.body':
    'बैलेंस शून्य होने पर, हर जुड़े नंबर पर भेजना रुक जाता है। कतार में मौजूद संदेश कभी नहीं ' +
    'खोते - फंड जोड़ते ही वे भेज दिए जाते हैं।',
  'wallet.topup.methodUpi': 'UPI',
  'wallet.topup.methodBankTransfer': 'बैंक ट्रांसफर',
  'wallet.history.title': 'टॉप-अप अनुरोध इतिहास',
  'wallet.history.loading': 'लोड हो रहा है…',
  'wallet.history.error': 'कुछ गलत हो गया। कृपया फिर से प्रयास करें।',
  'wallet.history.empty.title': 'अभी तक कोई टॉप-अप अनुरोध नहीं है',
  'wallet.history.empty.body': 'ऊपर टॉप-अप अनुरोध सबमिट करें, यह यहाँ सूचीबद्ध हो जाएगा।',
  'wallet.history.column.amount': 'राशि',
  'wallet.history.column.method': 'तरीका',
  'wallet.history.column.status': 'स्थिति',
  'wallet.history.column.createdAt': 'सबमिट किया गया',
  'wallet.history.column.note': 'टिप्पणी',

  'stepper.status.completed': 'पूरा हुआ',
  'stepper.status.current': 'वर्तमान चरण',
  'stepper.status.upcoming': 'आगामी',

  'groups.toast.actionError': 'कुछ गलत हो गया। कृपया फिर से प्रयास करें।',
} as const satisfies Catalogue;

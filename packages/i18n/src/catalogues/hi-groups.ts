/**
 * hi-groups.ts (P24 groups-messaging, Unit U2, step 5) - the `groups.*`/
 * `broadcasts.targetKind.*` Hindi keys, split out of `hi.ts` (same
 * `max-lines: 300` split idiom as `hi-broadcasts.ts`; matching sibling of
 * `en-groups.ts`). Must carry the identical key set as `en-groups.ts` (see
 * `catalogue-parity.test.ts`). HONEST COPY ONLY - see `@wp/domain`'s
 * `BANNED_CLAIMS` for the full list this file must never contain, in any
 * language.
 *
 * `groups.disclosure` keeps the risk disclosure in English (same Hinglish
 * convention `hi-broadcasts.ts` documents for `broadcasts.disclosure` - no
 * Hindi translation exists for this string yet).
 */

/**
 * Kept in English, same convention as `en-groups.ts`'s own
 * `GROUP_RISK_DISCLOSURE_LITERAL` - `scripts/check-copy.ts`'s co-presence
 * clause matches the capitalised English "Group" token regardless of
 * surrounding language, so this file's disclosure value must carry the
 * verbatim English disclosure text too.
 */
const GROUP_RISK_DISCLOSURE_LITERAL = `Sending promotional messages into WhatsApp groups is one of the highest report-rate behaviours on the platform. A single annoyed member can report the message, and group reports are visible to WhatsApp in a way one-to-one messages are not. WP caps group sending, disables it during warm-up, and switches it off first when your account's health signals worsen — but a group blast is riskier than the same message sent one-to-one, and no pacing changes that.`;

export const hiGroups = {
  'nav.groups': 'समूह',

  'groups.title': 'समूह',
  'groups.subtitle':
    'इस नंबर से पहले से जुड़े WhatsApp समूहों को भेजें। समूह में भेजना उसी संदेश को एक-एक करके ' +
    'भेजने से ज़्यादा जोखिम भरा है।',
  'groups.disclosure': GROUP_RISK_DISCLOSURE_LITERAL,

  'groups.list.empty': 'इस नंबर के लिए अभी तक कोई समूह सिंक नहीं हुआ है।',
  'groups.subject.fallback': 'बिना नाम का समूह',
  'groups.list.syncNow': 'समूह सिंक करें',
  'groups.list.syncRequested':
    'सिंक का अनुरोध किया गया। यह नंबर जुड़े रहने पर समूह एक मिनट के भीतर अपडेट हो जाएंगे।',
  'groups.list.syncRateLimited':
    'समूह एक घंटे से कम समय पहले सिंक किए गए थे। अगला सिंक {time} पर उपलब्ध होगा।',
  'groups.list.lastSynced': 'आखिरी बार {time} पर सिंक किया गया',
  'groups.list.neverSynced': 'कभी सिंक नहीं किया गया',
  'groups.column.subject': 'समूह',
  'groups.column.participants': 'सदस्य',
  'groups.column.role': 'आपकी भूमिका',
  'groups.column.status': 'भेजना',

  'groups.role.member': 'सदस्य',
  'groups.role.admin': 'एडमिन',
  'groups.role.superadmin': 'मालिक',

  'groups.status.enabled': 'चालू',
  'groups.status.disabled': 'बंद',

  'groups.reason.NOT_SEND_ENABLED': 'इस समूह के लिए भेजना बंद है।',
  'groups.reason.ANNOUNCE_MEMBER_ONLY':
    'घोषणा समूह: केवल एडमिन ही पोस्ट कर सकते हैं, और यह नंबर एक सदस्य है।',
  'groups.reason.GROUP_CAP_ZERO_AT_TIER': 'आपके मौजूदा वार्म-अप स्तर पर समूह भेजना बंद है।',
  'groups.reason.DEVICE_BUDGET_EXCEEDED':
    'इस समूह को चालू करने से इस नंबर का समूह-सदस्य डिवाइस बजट पार हो जाएगा ({total} में से ' +
    '{max} उपयोग में)।',
  'groups.reason.group_forbidden':
    'WhatsApp ने इस समूह को भेजना अस्वीकार कर दिया (एडमिन नहीं, केवल-घोषणा, या अब सदस्य नहीं)। ' +
    'केवल इस समूह के लिए भेजना बंद कर दिया गया।',
  'groups.reason.leave_requested': 'इस समूह को छोड़ा जा रहा है।',
  'groups.reason.not_participant': 'यह नंबर अब समूह में नहीं है।',
  'groups.reason.generic': 'इस समूह के लिए भेजना बंद है।',

  'groups.instancePicker.label': 'नंबर',
  'groups.instancePicker.placeholder': 'एक नंबर चुनें',

  'groups.enable.title': 'इस समूह में भेजना चालू करें?',
  'groups.enable.reach': '~{count} लोग इसे देखेंगे।',
  'groups.enable.confirm': 'चालू करें',
  'groups.enable.cancel': 'रद्द करें',
  'groups.disable.confirm': 'बंद करें',

  'groups.leave.title': 'इस समूह को छोड़ें?',
  'groups.leave.body':
    'छोड़ना हमेशा अनुमति प्राप्त है। नंबर के छोड़ने के बाद इस समूह के लिए कतार में मौजूद संदेश ' +
    'विफल हो जाएंगे।',
  'groups.leave.confirm': 'समूह छोड़ें',

  'groups.cap.today': 'आज समूह भेजे गए: {sent} में से {cap}',
  'groups.cap.remaining': 'आज {remaining} समूह भेजना बाकी है',
  'groups.cap.offAtTier': 'आपके मौजूदा वार्म-अप स्तर पर समूह भेजना बंद है।',

  'groups.budget.line': 'ट्रैक किए गए सदस्य डिवाइस: {total} में से {max}',
  'groups.budget.derivedNote': 'सदस्य संख्या से अनुमानित, मापा नहीं गया।',

  'groups.optout.unattributableWarning':
    'समूह के अंदर से भेजा गया ऑप्ट-आउट कीवर्ड किसी विशिष्ट संपर्क से जुड़ा हुआ न हो सकता है।',

  'groups.notification.group_forbidden.title': 'समूह भेजना बंद किया गया',
  'groups.notification.group_forbidden.body':
    'WhatsApp ने एक समूह को भेजना अस्वीकार कर दिया। केवल उस समूह के लिए भेजना बंद किया गया; यह ' +
    'नंबर भेजना जारी रखता है।',

  'broadcasts.targetKind.label': 'भेजें',
  'broadcasts.targetKind.contacts': 'संपर्क',
  'broadcasts.targetKind.groups': 'समूह',
  'broadcasts.composer.groupsAllEnabled': 'जिन समूहों में भेजना चालू है, उन सभी को यह मिलेगा।',
  'broadcasts.composer.groupsSelectedCount': '{count} समूह चुने गए',

  'groups.preflight.reach': 'अनुमानित पहुंच: {groups} समूहों में ~{count} लोग',
  'groups.preflight.capLine': 'आज समूह सीमा: {cap} में से {remaining} शेष',
  'groups.preflight.offAtTier': 'आपके मौजूदा वार्म-अप स्तर पर समूह भेजना बंद है',
  'groups.preflight.skipped': '{count} समूह छोड़े गए ({reasons})',
} as const;

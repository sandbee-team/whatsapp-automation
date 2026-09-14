/**
 * hi-contacts.ts (P20 Unit U9, step 10) - the `contacts.*`/`nav.contacts`
 * Hindi keys, split out of `hi.ts` (that file sat near the `max-lines: 300`
 * cap - core-invariants.md's mandatory split idiom, sibling module rather
 * than trimming a contract/behaviour comment). Spread into `hi.ts`'s default
 * export; `en-contacts.ts` is the matching English sibling, and both must
 * carry the identical `contacts.*`/`nav.contacts` key set
 * (`features/contacts/copy.test.ts` proves parity).
 */
const CONTACTS_ATTESTATION_NOTICE_LITERAL =
  'We record who asserted consent; we do not and cannot verify it.';

export const hiContacts = {
  'nav.contacts': 'संपर्क',

  'contacts.title': 'संपर्क',
  'contacts.subtitle': 'आपके संपर्कों और उनकी ऑप्ट-आउट स्थिति की सूची।',
  'contacts.searchLabel': 'संपर्क खोजें',
  'contacts.searchPlaceholder': 'नाम या फ़ोन नंबर से खोजें',
  'contacts.filter.optOutAll': 'सभी संपर्क',
  'contacts.filter.optOutOptedOut': 'ऑप्ट-आउट किए गए',
  'contacts.filter.optOutNotOptedOut': 'ऑप्ट-आउट नहीं किए गए',
  'contacts.table.name': 'नाम',
  'contacts.table.phone': 'फ़ोन नंबर',
  'contacts.table.tags': 'टैग',
  'contacts.table.status': 'स्थिति',
  'contacts.table.updatedAt': 'आखिरी अपडेट',
  'contacts.table.optedOutBadge': 'ऑप्ट-आउट किया गया',
  'contacts.loadMore': 'और लोड करें',
  'contacts.loading': 'लोड हो रहा है…',
  'contacts.error': 'कुछ गलत हो गया। कृपया फिर से प्रयास करें।',
  'contacts.empty.title': 'अभी तक कोई संपर्क नहीं है',
  'contacts.empty.body':
    'अपनी संपर्क सूची बनाने के लिए एक संपर्क जोड़ें या CSV सूची इम्पोर्ट करें।',
  'contacts.addButton': 'संपर्क जोड़ें',
  'contacts.importButton': 'CSV इम्पोर्ट करें',
  'contacts.exportButton': 'CSV एक्सपोर्ट करें',
  'contacts.mfaRequired': 'जारी रखने के लिए अपने ऑथेंटिकेटर कोड से फिर से प्रमाणित करें।',

  'contacts.export.confirmTitle': 'संपर्क एक्सपोर्ट करें',
  'contacts.export.confirmButton': 'CSV डाउनलोड करें',
  'contacts.export.cancelButton': 'रद्द करें',

  'contacts.form.title': 'एक संपर्क जोड़ें',
  'contacts.form.phoneLabel': 'फ़ोन नंबर',
  'contacts.form.phoneDescription': 'देश कोड सहित लिखें, जैसे +91XXXXXXXXXX।',
  'contacts.form.countryLabel': 'डिफ़ॉल्ट देश',
  'contacts.form.nameLabel': 'नाम',
  'contacts.form.submitButton': 'संपर्क जोड़ें',
  'contacts.form.genericError': 'कुछ गलत हो गया। कृपया फिर से प्रयास करें।',

  'contacts.drawer.title': 'संपर्क विवरण',
  'contacts.drawer.phoneLabel': 'फ़ोन नंबर',
  'contacts.drawer.nameLabel': 'नाम',
  'contacts.drawer.saveButton': 'बदलाव सहेजें',
  'contacts.drawer.savedMessage': 'बदलाव सहेज लिए गए।',
  'contacts.drawer.attrsTitle': 'विशेषताएं',
  'contacts.drawer.attrsEmpty': 'कोई विशेषता दर्ज नहीं है।',
  'contacts.drawer.tagsTitle': 'टैग',
  'contacts.drawer.addTagPlaceholder': 'नया टैग नाम',
  'contacts.drawer.addTagButton': 'टैग बनाएं',
  'contacts.drawer.removeTagButton': 'हटाएं',
  'contacts.drawer.optOutTitle': 'मैसेजिंग स्थिति',
  'contacts.drawer.optedOutSince': '{date} से ऑप्ट-आउट किया हुआ है',
  'contacts.drawer.notOptedOut': 'ऑप्ट-आउट नहीं किया गया',
  'contacts.drawer.eraseButton': 'संपर्क मिटाएं',
  'contacts.drawer.eraseConfirmButton': 'मिटाने की पुष्टि करें',
  'contacts.drawer.eraseCancelButton': 'रद्द करें',
  'contacts.drawer.eraseError': 'यह संपर्क मिटाया नहीं जा सका। कृपया फिर से प्रयास करें।',

  'contacts.import.title': 'संपर्क इम्पोर्ट करें',
  'contacts.import.step.upload': 'अपलोड',
  'contacts.import.step.mapping': 'मैपिंग',
  'contacts.import.step.attestation': 'सत्यापन घोषणा',
  'contacts.import.step.progress': 'प्रगति',
  'contacts.import.step.result': 'परिणाम',
  'contacts.import.upload.label': 'CSV फ़ाइल',
  'contacts.import.upload.description': '16 MB तक की एक CSV फ़ाइल।',
  'contacts.import.upload.button': 'अपलोड करें',
  'contacts.import.tooLarge': 'यह फ़ाइल 16 MB से बड़ी है। कृपया इसे छोटी फ़ाइलों में विभाजित करें।',
  'contacts.import.notCsv': 'कृपया एक .csv फ़ाइल चुनें।',
  'contacts.import.uploadError':
    'इस फ़ाइल को अपलोड करने में कुछ गलत हो गया। कृपया फिर से प्रयास करें।',
  'contacts.import.mapping.phoneLabel': 'फ़ोन नंबर कॉलम',
  'contacts.import.mapping.nameLabel': 'नाम कॉलम (वैकल्पिक)',
  'contacts.import.mapping.attrKeyLabel': 'विशेषता की-नाम',
  'contacts.import.mapping.attrColumnLabel': 'कॉलम',
  'contacts.import.mapping.addAttrButton': 'विशेषता मैपिंग जोड़ें',
  'contacts.import.mapping.countryLabel': 'डिफ़ॉल्ट देश',
  'contacts.import.mapping.tagsLabel': 'इम्पोर्ट किए गए संपर्कों पर टैग लगाएं',
  'contacts.import.mapping.previewTitle': 'पूर्वावलोकन (पहली 10 पंक्तियां)',
  'contacts.import.mapping.continueButton': 'जारी रखें',
  'contacts.import.attestationNotice': CONTACTS_ATTESTATION_NOTICE_LITERAL,
  'contacts.import.attestationNoticeHi':
    'हम यह दर्ज करते हैं कि सहमति का दावा किसने किया; हम इसे सत्यापित नहीं करते और नहीं कर सकते।',
  'contacts.import.attestationCheckbox':
    'मैं पुष्टि करता/करती हूं कि इस सूची के लोगों ने हमसे संदेश प्राप्त करने के लिए सहमति दी है।',
  'contacts.import.attestationSourceLabel': 'यह सूची कहां से आई?',
  'contacts.import.startButton': 'इम्पोर्ट शुरू करें',
  'contacts.import.progress.title': 'आपके संपर्क इम्पोर्ट किए जा रहे हैं',
  'contacts.import.progress.rowsProcessed': '{cursorRow} पंक्तियां संसाधित',
  'contacts.import.progress.rowsProcessedOfTotal': '{cursorRow} / {totalRows} पंक्तियां संसाधित',
  'contacts.import.progress.cancelButton': 'इम्पोर्ट रद्द करें',
  'contacts.import.result.title': 'इम्पोर्ट समाप्त हुआ',
  'contacts.import.result.imported': 'इम्पोर्ट किए गए',
  'contacts.import.result.updated': 'अपडेट किए गए',
  'contacts.import.result.duplicates': 'डुप्लीकेट',
  'contacts.import.result.invalid': 'अमान्य',
  'contacts.import.result.optedOutPreserved': 'ऑप्ट-आउट सुरक्षित रखे गए',
  'contacts.import.downloadErrorsButton': 'एरर CSV डाउनलोड करें',
  'contacts.import.error.max_contacts_exceeded':
    'यह इम्पोर्ट आपकी योजना की संपर्क सीमा से अधिक हो जाएगा। कुछ संपर्क हटाएं या सीमा बढ़ाने के लिए ' +
    'सहायता टीम से संपर्क करें।',
  'contacts.import.error.generic': 'इम्पोर्ट पूरा नहीं हो सका। कृपया फिर से प्रयास करें।',
  'contacts.import.closeButton': 'बंद करें',

  'contacts.tags.filterLabel': 'टैग से फ़िल्टर करें',
} as const;

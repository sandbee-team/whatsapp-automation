/**
 * hi-broadcasts.ts (P23a Unit U3, step 1) - the `broadcasts.*`/`nav.broadcasts`
 * Hindi keys, split out of `hi.ts` (same `max-lines: 300` split idiom as
 * `en-broadcasts.ts`; matching sibling of `hi-contacts.ts`). Must carry the
 * identical key set as `en-broadcasts.ts` (see `catalogue-parity.test.ts`).
 * HONEST COPY ONLY - see `@wp/domain`'s `BANNED_CLAIMS` for the full list
 * this file must never contain, in any language.
 *
 * `broadcasts.disclosure` keeps the brand disclosure in English (same
 * Hinglish convention as `instances.card.safeModeDisclaimer` in `hi.ts` -
 * no Hindi translation exists for this string yet).
 */

/**
 * P23 Unit U2 (step 3) - kept in English, same "Safe Mode" convention `hi.ts`
 * documents: `scripts/check-copy.ts`'s co-presence clause matches the literal
 * English "Broadcast" token regardless of surrounding language, so this
 * file's disclosure value must carry the verbatim English disclosure text
 * too (no Hinglish translation exists for this string yet, same precedent as
 * `SAFE_MODE_DISCLAIMER_LITERAL` in `hi.ts`).
 */
const BROADCAST_DISCLOSURE_LITERAL = `What "Broadcast" means in WP. WhatsApp's own broadcast lists have a limitation most people discover the hard way: a broadcast-list message is only delivered to recipients who have already saved your number in their phone. Everyone else silently receives nothing. WP does not use broadcast lists. When you send a WP Broadcast, we create one individually-addressed message per recipient — the same thing as if you had opened each chat and typed it yourself — and we send them one at a time, paced, from your connected number. That is why a broadcast to 2,000 people takes hours or days rather than seconds: the pacing is the product. It also means each recipient sees a normal one-to-one message from you, can reply to it, and their reply lands in your Inbox. A Broadcast is not a licence to exceed your account's daily cap — it simply takes as long as your cap allows, and the panel shows you the honest estimated finish time before you start.`;

/**
 * `broadcasts.preflight.accountDetail` below names "Safe Mode" (kept in
 * English, same Hinglish convention as elsewhere in this file) -
 * `scripts/check-copy.ts`'s co-presence clause (b) requires this file to
 * also carry `SAFE_MODE_DISCLAIMER` verbatim; byte-identical COPY of
 * `@wp/domain`'s `SAFE_MODE_DISCLAIMER`, same idiom as `en-broadcasts.ts`'s
 * own `BROADCAST_ACCOUNT_SAFE_MODE_DISCLAIMER_LITERAL`.
 */
export const BROADCAST_ACCOUNT_SAFE_MODE_DISCLAIMER_LITERAL = `Safe Mode paces your sending and watches your account's real signals. It reduces the risk of triggering spam or rate-limit signals from sending too fast or too cold. It cannot prevent or guarantee against WhatsApp restrictions — bans also come from recipient reports, message content and account reputation, which no sender-side pacing can control.`;

export const hiBroadcasts = {
  'nav.broadcasts': 'ब्रॉडकास्ट',
  'broadcasts.title': 'ब्रॉडकास्ट',

  'broadcasts.disclosure': BROADCAST_DISCLOSURE_LITERAL,
  'broadcasts.frequencyLine':
    'किसी और नंबर से वही ऑडियंस भेजने से किसी व्यक्ति को भेजे जाने वाले संदेशों की संख्या नहीं ' +
    'बढ़ती - फ्रीक्वेंसी सीमा पूरे वर्कस्पेस के लिए एक होती है।',
  'broadcasts.estimateCaveat': 'यह एक अनुमान है, गारंटी नहीं।',
  'broadcasts.backpressure.holding': 'कतार में जोड़ना रोका गया - {count} पहले से प्रतीक्षा में हैं',
  'broadcasts.cancel.notRecalled': 'पहले से भेजे गए संदेश वापस नहीं लिए जाते और रिफंड नहीं होते।',
  'broadcasts.epoch.stranded':
    'इस नंबर के पिछले लिंक के लिए {count} संदेश कतार में बनाए गए थे। इन्हें मौजूदा लिंक से भेजने के ' +
    'लिए संख्या की पुष्टि करें, या इन्हें रद्द करें।',
  'broadcasts.limit.overPlan':
    'यह ऑडियंस ({count}) आपकी प्लान सीमा ({limit}) से अधिक है। ऑडियंस घटाएं या हमसे संपर्क करें।',
  'broadcasts.limit.noPlan':
    'इस वर्कस्पेस से कोई प्लान जुड़ा नहीं है, इसलिए ब्रॉडकास्ट शुरू नहीं हो सकते।',

  'broadcasts.preflight.title': 'शुरू करने से पहले समीक्षा करें',
  'broadcasts.preflight.audience': 'ऑडियंस',
  'broadcasts.preflight.contacts': '{count} संपर्क',
  'broadcasts.preflight.skipped': '{count} छोड़े गए: {reason}',
  'broadcasts.preflight.skipReason.opted_out': 'ऑप्ट-आउट किया हुआ',
  'broadcasts.preflight.skipReason.missing_var': 'वेरिएबल {token} गायब है',
  'broadcasts.preflight.alreadyMessaged': 'पहले से संदेश भेजा गया',
  'broadcasts.preflight.alreadyMessagedDetail':
    'इनमें से {count} को हाल ही में आपके किसी नंबर से संदेश मिला है और वे उस विंडो के समाप्त होने ' +
    'तक प्रतीक्षा करेंगे (नीचे दिए गए अनुमान से बाहर रखा गया)',
  'broadcasts.preflight.billable': 'बिल योग्य',
  'broadcasts.preflight.billableDetail': '{count} संदेश × {rate} = {total}',
  'broadcasts.preflight.wallet': 'वॉलेट बैलेंस',
  'broadcasts.preflight.walletDetail': '{balance} → इस ब्रॉडकास्ट के बाद ≈ {after}',
  'broadcasts.preflight.walletInsufficient':
    'आपका वॉलेट इस ब्रॉडकास्ट के लिए पर्याप्त नहीं है। वॉलेट खाली होने पर भेजना रुक जाता है; ' +
    'कतार में मौजूद संदेश सुरक्षित रहते हैं और टॉप-अप के बाद फिर से शुरू होते हैं।',
  'broadcasts.preflight.account': 'खाता',
  'broadcasts.preflight.accountDetail':
    '{label} · Safe Mode स्तर {tier} · {cap}/दिन सीमा · आज {sent} पहले ही भेजे गए',
  'broadcasts.preflight.estimate': 'अनुमानित समाप्ति',
  'broadcasts.preflight.estimateDays': 'लगभग {days} दिन ({date})',
  'broadcasts.preflight.estimateToday': 'आज ({date})',
  'broadcasts.preflight.estimateUnavailable': 'कोई अनुमान नहीं: इस नंबर की दैनिक सीमा अभी 0 है।',
  'broadcasts.preflight.optionsIntro': 'जल्दी समाप्त करने के लिए आप यह कर सकते हैं:',
  'broadcasts.preflight.option.reduce_audience': 'ऑडियंस घटाएं',
  'broadcasts.preflight.option.wait_for_warm_up':
    'दैनिक सीमा बढ़ाने के लिए वार्म-अप का इंतज़ार करें',
  'broadcasts.preflight.fanOutAck':
    '{threshold} से अधिक प्राप्तकर्ताओं को आज वही संदेश मिलेगा, इसलिए संदेश Numbers पेज पर एक ' +
    'पुष्टिकरण बैनर के पीछे तब तक कतार में रहेंगे जब तक आप इसे स्वीकार नहीं करते।',
  'broadcasts.preflight.start': 'ब्रॉडकास्ट शुरू करें',
  'broadcasts.preflight.back': 'संपादन पर वापस जाएं',
  'broadcasts.preflight.starting': 'शुरू हो रहा है…',
  'broadcasts.preflight.priceNote': 'कीमतें WP की प्रति-संदेश कीमत हैं।',

  'broadcasts.composer.title': 'नया ब्रॉडकास्ट',
  'broadcasts.composer.nameLabel': 'नाम',
  'broadcasts.composer.instanceLabel': 'भेजने वाला नंबर',
  'broadcasts.composer.instanceOption': '{label} · स्तर {tier} · {cap}/दिन',
  'broadcasts.composer.audienceLabel': 'ऑडियंस',
  'broadcasts.composer.tagsLabel': 'टैग',
  'broadcasts.composer.contactSearchLabel': 'व्यक्तिगत संपर्क जोड़ें',
  'broadcasts.composer.contactSearchPlaceholder': 'नाम या नंबर से खोजें',
  'broadcasts.composer.search': 'खोजें',
  'broadcasts.composer.audienceSummary': '{tags} टैग · {contacts} संपर्क चुने गए',
  'broadcasts.composer.bodyLabel': 'संदेश',
  'broadcasts.composer.variablesLabel': 'एक वेरिएबल जोड़ें',
  'broadcasts.composer.variablesHelp':
    'जिस संपर्क का कोई वेरिएबल गायब है उसे छोड़ दिया जाता है और उसे कभी खाली जगह वाला संदेश नहीं ' +
    'भेजा जाता।',
  'broadcasts.composer.attrKeyPlaceholder': 'कस्टम एट्रिब्यूट की',
  'broadcasts.composer.attrKeyInvalid':
    'एट्रिब्यूट की केवल लोअरकेस अक्षर, अंक और अंडरस्कोर हो सकते हैं, और अक्षर से शुरू होने चाहिए।',
  'broadcasts.composer.insert': 'जोड़ें',
  'broadcasts.composer.tokensInUse': 'इस संदेश में वेरिएबल: {tokens}',
  'broadcasts.composer.priorityLabel': 'प्राथमिकता',
  'broadcasts.composer.priorityNote':
    'प्राथमिकता आपकी कतार को क्रम में लगाती है। यह डिलीवरी-स्पीड की गारंटी नहीं है और आपकी दैनिक ' +
    'सीमा नहीं बदलती।',
  'broadcasts.composer.priority.high': 'उच्च',
  'broadcasts.composer.priority.normal': 'सामान्य',
  'broadcasts.composer.priority.low': 'निम्न',
  'broadcasts.composer.scheduleLabel': 'शेड्यूल (वैकल्पिक)',
  'broadcasts.composer.scheduleHelp':
    'संदेश अभी कतार में जुड़ते हैं और आपकी भेजने की विंडो व सीमा के भीतर, इस समय पर भेजना शुरू करते ' +
    'हैं।',
  'broadcasts.composer.reviewQuote': 'कोटेशन देखें',
  'broadcasts.composer.quoting': 'आपका कोटेशन तैयार किया जा रहा है…',
  'broadcasts.composer.error.validation': 'कृपया सभी आवश्यक फ़ील्ड भरें।',
  'broadcasts.composer.error.limit':
    'यह ऑडियंस आपकी प्लान की ब्रॉडकास्ट सीमा से अधिक है। ऑडियंस घटाएं या हमसे संपर्क करें।',
  'broadcasts.composer.error.conflict':
    'यह ब्रॉडकास्ट पहले ही बदल चुका है। रीलोड करें और फिर से प्रयास करें।',
  'broadcasts.composer.error.generic': 'कुछ गलत हो गया। कुछ भी नहीं भेजा गया।',
  'broadcasts.composer.remove': 'हटाएं',

  'broadcasts.list.title': 'ब्रॉडकास्ट',
  'broadcasts.list.new': 'नया ब्रॉडकास्ट',
  'broadcasts.list.empty': 'अभी तक कोई ब्रॉडकास्ट नहीं है।',
  'broadcasts.list.loadMore': 'और लोड करें',
  'broadcasts.list.col.name': 'नाम',
  'broadcasts.list.col.status': 'स्थिति',
  'broadcasts.list.col.audience': 'ऑडियंस',
  'broadcasts.list.col.quote': 'कोटेशन',
  'broadcasts.list.col.created': 'बनाया गया',

  'broadcasts.status.draft': 'ड्राफ्ट',
  'broadcasts.status.scheduled': 'शेड्यूल किया गया',
  'broadcasts.status.snapshotting': 'ऑडियंस तैयार की जा रही है',
  'broadcasts.status.expanding': 'कतार में जोड़ा जा रहा है',
  'broadcasts.status.running': 'भेजा जा रहा है',
  'broadcasts.status.paused': 'रोका गया',
  'broadcasts.status.completed': 'पूरा हुआ',
  'broadcasts.status.cancelled': 'रद्द किया गया',
  'broadcasts.status.failed': 'विफल',

  'broadcasts.funnel.title': 'प्रगति',
  'broadcasts.funnel.total': 'ऑडियंस',
  'broadcasts.funnel.queued': 'कतार में',
  'broadcasts.funnel.deferredOfWhich': 'इनमें से {count} पेसिंग के लिए प्रतीक्षा में हैं',
  'broadcasts.funnel.sent': 'भेजे गए',
  'broadcasts.funnel.delivered': 'डिलीवर हुए',
  'broadcasts.funnel.read': 'पढ़े गए',
  'broadcasts.funnel.skipped': 'छोड़े गए',
  'broadcasts.funnel.failed': 'विफल',
  'broadcasts.funnel.cancelled': 'रद्द किए गए',
  'broadcasts.funnel.charged': 'अब तक शुल्क लिया गया: {amount}',
  'broadcasts.funnel.receiptsLowerBound':
    'डिलीवर और पढ़े गए की संख्या न्यूनतम आंकड़ा है: WhatsApp यह गारंटी नहीं देता कि हर रसीद किसी ' +
    'लिंक किए गए डिवाइस तक पहुंचे।',

  'broadcasts.detail.pause': 'रोकें',
  'broadcasts.detail.resume': 'फिर से शुरू करें',
  'broadcasts.detail.cancel': 'ब्रॉडकास्ट रद्द करें',
  'broadcasts.detail.pauseConfirm':
    'इस ब्रॉडकास्ट को रोकें? कतार में मौजूद संदेश सुरक्षित रहते हैं और जब तक आप फिर से शुरू नहीं ' +
    'करते तब तक कुछ और नहीं भेजा जाता।',
  'broadcasts.detail.resumeConfirm':
    'भेजना फिर से शुरू करें? संदेश आपकी दैनिक सीमा और भेजने की विंडो के भीतर जारी रहेंगे।',
  'broadcasts.cancel.confirmBody':
    'इस ब्रॉडकास्ट को रद्द करें? कतार में मौजूद संदेश नहीं भेजे जाएंगे।',
  'broadcasts.detail.confirm': 'पुष्टि करें',
  'broadcasts.detail.back': 'वापस',
  'broadcasts.detail.notFound': 'यह ब्रॉडकास्ट मौजूद नहीं है या किसी अन्य वर्कस्पेस का है।',
  'broadcasts.detail.draftNote':
    'यह ब्रॉडकास्ट अभी शुरू नहीं हुआ है। कोटेशन की समीक्षा करें और इसे कंपोज़र से शुरू करें।',
  'broadcasts.detail.sendingFrom': '{label} से भेजा जा रहा है',
  'broadcasts.detail.scheduledFor': '{date} के लिए शेड्यूल किया गया',
  'broadcasts.detail.createdAt': '{date} को बनाया गया',
} as const;

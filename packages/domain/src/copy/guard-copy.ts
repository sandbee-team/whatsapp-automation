import { DENY_REASONS, type DenyReason } from '../pacing/deny-reasons.js';

/**
 * guard-copy.ts (P14 Unit U7, step 9) - verbatim user-facing copy for every
 * `DenyReason` (`@wp/domain`'s `DENY_REASONS`, 17 members). No caller may
 * hand-roll pacing/guard-deferral copy; every string is imported from here.
 * Driven from `DENY_REASONS` itself (a `satisfies Record<DenyReason, ...>`
 * plus the runtime `every_deny_reason_has_an_en_and_hi_string` test iterates
 * the union) so a new `DenyReason` member with no copy entry fails a test
 * rather than silently rendering blank.
 *
 * Every string states: what happened, what is preserved (queued work is
 * never lost - core invariant 5), when it resumes (or what unblocks it), and
 * what the user can do - and NEVER a claim that pacing/guards prevent a
 * WhatsApp restriction (invariant 6). The two-word pacing-feature product
 * name is deliberately never spelled out here (`check-copy.ts`'s co-presence
 * clause would then require the matching disclaimer text verbatim in this
 * same file for a per-reason string that has no room to carry it) -
 * "pacing"/"sending limits" describe the same mechanism in plain words
 * instead.
 *
 * BLOCKED_WORD takes a `{category}` placeholder and NEVER the matched word
 * itself (`blocked-words.ts`'s own contract: `matchBlockedWord` returns only
 * a category, never the phrase - a filter-tuning oracle must never be
 * buildable from this copy). OPT_OUT says the recipient asked to stop and
 * the message was CANCELLED, never "failed".
 */

export interface GuardCopyEntry {
  en: string;
  hi: string;
}

export const GUARD_COPY: Readonly<Record<DenyReason, GuardCopyEntry>> = Object.freeze({
  MIN_GAP: Object.freeze({
    en: 'This message is waiting for the minimum gap between sends on this number. It stays queued and will go out automatically once the gap has passed. No action needed.',
    hi: 'यह मैसेज इस नंबर से भेजे जाने वाले मैसेज के बीच के न्यूनतम अंतराल का इंतज़ार कर रहा है। यह कतार में सुरक्षित है और अंतराल पूरा होते ही अपने आप भेज दिया जाएगा। आपको कुछ करने की ज़रूरत नहीं है।',
  }),
  DAILY_CAP: Object.freeze({
    en: "This number has reached today's sending limit. Your message stays queued and will send automatically after the limit resets at local midnight. Nothing is lost.",
    hi: 'इस नंबर की आज की भेजने की सीमा पूरी हो गई है। आपका मैसेज कतार में सुरक्षित है और स्थानीय आधी रात को सीमा रीसेट होते ही अपने आप भेज दिया जाएगा। कुछ भी खोया नहीं है।',
  }),
  HOURLY_CAP: Object.freeze({
    en: 'This number has reached its sending limit for the current hour. Your message stays queued and will send automatically once the next hour begins. Nothing is lost.',
    hi: 'इस नंबर की मौजूदा घंटे की भेजने की सीमा पूरी हो गई है। आपका मैसेज कतार में सुरक्षित है और अगला घंटा शुरू होते ही अपने आप भेज दिया जाएगा। कुछ भी खोया नहीं है।',
  }),
  NEW_CONV_CAP: Object.freeze({
    en: "This number has reached today's limit for starting new conversations. Your message stays queued and will send automatically once the limit resets at local midnight. Nothing is lost.",
    hi: 'इस नंबर की आज नई बातचीत शुरू करने की सीमा पूरी हो गई है। आपका मैसेज कतार में सुरक्षित है और स्थानीय आधी रात को सीमा रीसेट होते ही अपने आप भेज दिया जाएगा। कुछ भी खोया नहीं है।',
  }),
  COLD_RATIO: Object.freeze({
    en: "This number is still warming up and has reached its limit for messages to people who haven't messaged it first today. Your message stays queued and will send automatically after the limit resets at local midnight. Nothing is lost.",
    hi: 'यह नंबर अभी वार्मअप हो रहा है और आज उन लोगों को मैसेज भेजने की सीमा पूरी हो गई है जिन्होंने पहले खुद मैसेज नहीं भेजा। आपका मैसेज कतार में सुरक्षित है और स्थानीय आधी रात को सीमा रीसेट होते ही अपने आप भेज दिया जाएगा। कुछ भी खोया नहीं है।',
  }),
  GROUP_DAILY_CAP: Object.freeze({
    en: "This number has reached today's limit for group messages. Your message stays queued and will send automatically after the limit resets at local midnight. Nothing is lost.",
    hi: 'इस नंबर की आज ग्रुप मैसेज भेजने की सीमा पूरी हो गई है। आपका मैसेज कतार में सुरक्षित है और स्थानीय आधी रात को सीमा रीसेट होते ही अपने आप भेज दिया जाएगा। कुछ भी खोया नहीं है।',
  }),
  PLAN_CAP: Object.freeze({
    en: "Your account has reached today's plan sending limit. Your message stays queued and will send automatically after the limit resets at local midnight, or you can upgrade your plan. Nothing is lost.",
    hi: 'आपके अकाउंट की आज की प्लान भेजने की सीमा पूरी हो गई है। आपका मैसेज कतार में सुरक्षित है और स्थानीय आधी रात को सीमा रीसेट होते ही अपने आप भेज दिया जाएगा, या आप अपना प्लान अपग्रेड कर सकते हैं। कुछ भी खोया नहीं है।',
  }),
  OUTSIDE_WINDOW: Object.freeze({
    en: "This message is outside this number's configured sending hours. It stays queued and will send automatically when the sending window next opens. Nothing is lost.",
    hi: 'यह मैसेज इस नंबर के तय किए गए भेजने के समय के बाहर है। यह कतार में सुरक्षित है और भेजने का समय अगली बार शुरू होते ही अपने आप भेज दिया जाएगा। कुछ भी खोया नहीं है।',
  }),
  PER_RECIPIENT_FREQ: Object.freeze({
    en: 'This recipient has already received the maximum number of messages allowed in this window. This message stays queued and will send automatically once the window allows another message. Nothing is lost.',
    hi: 'इस प्राप्तकर्ता को इस अवधि में भेजे जा सकने वाले मैसेज की अधिकतम संख्या पहले ही मिल चुकी है। यह मैसेज कतार में सुरक्षित है और अवधि अगला मैसेज भेजने की अनुमति देते ही अपने आप भेज दिया जाएगा। कुछ भी खोया नहीं है।',
  }),
  NEEDS_HUMAN_ACK: Object.freeze({
    en: 'This exact message is going to a large number of recipients today. It stays queued and paused so a person on your team can confirm this is intended. Once confirmed, sending resumes immediately for everyone waiting. Nothing is lost - review and confirm from the duplicate-message screen.',
    hi: 'यह बिल्कुल एक जैसा मैसेज आज बड़ी संख्या में प्राप्तकर्ताओं को जा रहा है। यह कतार में सुरक्षित और रुका हुआ है ताकि आपकी टीम का कोई व्यक्ति पुष्टि कर सके कि यह जानबूझकर किया गया है। पुष्टि होते ही, इंतज़ार कर रहे सभी के लिए भेजना तुरंत फिर से शुरू हो जाता है। कुछ भी खोया नहीं है - डुप्लीकेट-मैसेज स्क्रीन से समीक्षा करें और पुष्टि करें।',
  }),
  INSTANCE_PAUSED: Object.freeze({
    en: 'This WhatsApp connection is temporarily paused, so sending has stopped for now. Your message stays queued and will send automatically once the connection is resumed. Nothing is lost.',
    hi: 'यह WhatsApp कनेक्शन अस्थायी रूप से रुका हुआ है, इसलिए फिलहाल भेजना बंद है। आपका मैसेज कतार में सुरक्षित है और कनेक्शन फिर से शुरू होते ही अपने आप भेज दिया जाएगा। कुछ भी खोया नहीं है।',
  }),
  NOT_CONNECTED: Object.freeze({
    en: "This number isn't currently connected, so sending has stopped for now. Your message stays queued and will send automatically once the number reconnects. Check the instance page to reconnect.",
    hi: 'यह नंबर फिलहाल कनेक्ट नहीं है, इसलिए भेजना अभी बंद है। आपका मैसेज कतार में सुरक्षित है और नंबर फिर से कनेक्ट होते ही अपने आप भेज दिया जाएगा। फिर से कनेक्ट करने के लिए इंस्टेंस पेज देखें।',
  }),
  OPT_OUT: Object.freeze({
    en: "This recipient asked to stop receiving messages, so this message was cancelled and will not be sent. This is not a failure - it reflects the recipient's request. They can be re-subscribed manually if they ask to receive messages again.",
    hi: 'इस प्राप्तकर्ता ने मैसेज पाना बंद करने का अनुरोध किया था, इसलिए यह मैसेज रद्द कर दिया गया और भेजा नहीं जाएगा। यह प्राप्तकर्ता के अपने अनुरोध के कारण है। अगर वे दोबारा मैसेज पाना चाहें तो उन्हें फिर से जोड़ा जा सकता है।',
  }),
  BLOCKED_WORD: Object.freeze({
    en: 'This message could not be sent because it contains content matching our {category} policy. Edit the message to remove the flagged content and try sending again.',
    hi: 'यह मैसेज नहीं भेजा जा सका क्योंकि इसमें हमारी {category} नीति से मेल खाने वाली सामग्री है। फ़्लैग की गई सामग्री हटाने के लिए मैसेज संपादित करें और फिर से भेजने का प्रयास करें।',
  }),
  LINK_IN_FIRST_MESSAGE: Object.freeze({
    en: 'This message could not be sent because it contains a link and this is the first message to this recipient. Remove the link, or wait until the recipient has replied at least once, then try again.',
    hi: 'यह मैसेज नहीं भेजा जा सका क्योंकि इसमें एक लिंक है और यह इस प्राप्तकर्ता को भेजा जाने वाला पहला मैसेज है। लिंक हटाएं, या तब तक इंतज़ार करें जब तक प्राप्तकर्ता कम से कम एक बार जवाब न दे दे, फिर दोबारा प्रयास करें।',
  }),
  NO_LEDGER_ROW: Object.freeze({
    en: "This number's sending state hasn't finished setting up yet. Your message stays queued and will be evaluated again shortly. Nothing is lost.",
    hi: 'इस नंबर की भेजने की स्थिति अभी पूरी तरह से सेट अप नहीं हुई है। आपका मैसेज कतार में सुरक्षित है और थोड़ी देर में फिर से जांचा जाएगा। कुछ भी खोया नहीं है।',
  }),
  UNKNOWN: Object.freeze({
    en: 'We could not confirm it was safe to send this message right now, so it has been held for a short time as a precaution. Your message stays queued and will be evaluated again shortly. If this repeats, contact support.',
    hi: 'हम अभी इस मैसेज को भेजना सुरक्षित है या नहीं इसकी पुष्टि नहीं कर सके, इसलिए इसे सावधानी के तौर पर थोड़ी देर के लिए रोक दिया गया है। आपका मैसेज कतार में सुरक्षित है और थोड़ी देर में फिर से जांचा जाएगा। अगर ऐसा बार-बार हो तो सहायता से संपर्क करें।',
  }),
}) satisfies Readonly<Record<DenyReason, GuardCopyEntry>>;

// Exhaustiveness guard (compile-time): if DENY_REASONS ever grows, the
// `satisfies` above forces a compile error until this object gains the new
// key too - kept as a no-op reference so DENY_REASONS is a real dependency
// of this module, not just of the test.
void DENY_REASONS;

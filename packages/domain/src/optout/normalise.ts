/**
 * Opt-out text normalisation (P14 Unit U2, phase step 2).
 *
 * `normaliseOptOutText` is applied identically to both the keyword list
 * (`keywords.ts`) and the inbound message text (`match.ts`), so a Devanagari
 * "STOP" and its Latin/Hinglish spelling both collapse to a form the
 * matcher can compare directly. The Devanagari->Latin map below is a small,
 * HAND-WRITTEN table (no transliteration library - this package is
 * browser-pure and dependency-light by design) covering the characters used
 * by the platform Hindi keywords (`बंद करो`, `रोको`, `हटाओ`) plus the common
 * matras/virama needed for close variants to transliterate stably. It does
 * NOT aim to be a general Devanagari transliterator - only internally
 * consistent for this platform's keyword set.
 */

/** Independent vowels. */
const DEVANAGARI_VOWELS: Readonly<Record<string, string>> = {
  अ: 'a',
  आ: 'aa',
  इ: 'i',
  ई: 'ii',
  उ: 'u',
  ऊ: 'uu',
  ऋ: 'ri',
  ए: 'e',
  ऐ: 'ai',
  ओ: 'o',
  औ: 'au',
};

/** Matras (dependent vowel signs) - applied after a consonant. */
const DEVANAGARI_MATRAS: Readonly<Record<string, string>> = {
  'ा': 'aa', // ा
  'ि': 'i', // ि
  'ी': 'ii', // ी
  'ु': 'u', // ु
  'ू': 'uu', // ू
  'ृ': 'ri', // ृ
  'े': 'e', // े
  'ै': 'ai', // ै
  'ो': 'o', // ो
  'ौ': 'au', // ौ
  '।': '', // । danda - treated as punctuation, stripped later anyway
};

/** Virama (halant) - suppresses the inherent 'a' of the preceding consonant. */
const VIRAMA = '्';

/** Anusvara/chandrabindu/visarga. */
const DEVANAGARI_MARKS: Readonly<Record<string, string>> = {
  'ं': 'n', // ं anusvara
  'ँ': 'n', // ँ chandrabindu
  'ः': 'h', // ः visarga
};

/** Consonants, each carrying an inherent 'a' unless followed by a matra/virama. */
const DEVANAGARI_CONSONANTS: Readonly<Record<string, string>> = {
  क: 'k',
  ख: 'kh',
  ग: 'g',
  घ: 'gh',
  ङ: 'ng',
  च: 'ch',
  छ: 'chh',
  ज: 'j',
  झ: 'jh',
  ञ: 'ny',
  ट: 't',
  ठ: 'th',
  ड: 'd',
  ढ: 'dh',
  ण: 'n',
  त: 't',
  थ: 'th',
  द: 'd',
  ध: 'dh',
  न: 'n',
  प: 'p',
  फ: 'ph',
  ब: 'b',
  भ: 'bh',
  म: 'm',
  य: 'y',
  र: 'r',
  ल: 'l',
  व: 'v',
  श: 'sh',
  ष: 'sh',
  स: 's',
  ह: 'h',
};

function transliterateDevanagari(input: string): string {
  let out = '';
  const chars = [...input];

  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i] as string;

    if (ch in DEVANAGARI_VOWELS) {
      out += DEVANAGARI_VOWELS[ch];
      continue;
    }

    if (ch in DEVANAGARI_MARKS) {
      out += DEVANAGARI_MARKS[ch];
      continue;
    }

    if (ch in DEVANAGARI_CONSONANTS) {
      const consonant = DEVANAGARI_CONSONANTS[ch] as string;
      const next = chars[i + 1];

      if (next === VIRAMA) {
        out += consonant;
        i += 1; // consume virama, drop inherent 'a'
        continue;
      }

      if (next !== undefined && next in DEVANAGARI_MATRAS) {
        out += consonant + DEVANAGARI_MATRAS[next];
        i += 1; // consume matra
        continue;
      }

      out += consonant + 'a'; // inherent vowel
      continue;
    }

    out += ch;
  }

  return out;
}

/** Matches any Unicode emoji/pictographic/symbol codepoint, to strip it. */
const EMOJI_RE = /[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/gu;
// Zero-width joiner and variation selector-16 (used to compose/style
// multi-codepoint emoji sequences) are each matched by their own single-
// codepoint regex: ESLint's no-misleading-character-class flags a
// combining codepoint placed alongside ANY other codepoint in one class.
const ZERO_WIDTH_JOINER_RE = /\u{200D}/gu;
const VARIATION_SELECTOR_16_RE = /\u{FE0F}/gu;

/** Punctuation to strip outright (not replaced with a space). */
const PUNCTUATION_RE = /[.,!?;:'"()[\]{}<>\-_/\\|~`^*+=@#%&]/g;

export function normaliseOptOutText(text: string): string {
  const transliterated = transliterateDevanagari(text);

  return transliterated
    .toLowerCase()
    .replace(EMOJI_RE, ' ')
    .replace(ZERO_WIDTH_JOINER_RE, ' ')
    .replace(VARIATION_SELECTOR_16_RE, ' ')
    .replace(PUNCTUATION_RE, '')
    .replace(/\s+/g, ' ')
    .trim();
}

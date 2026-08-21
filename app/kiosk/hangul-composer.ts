const INITIALS = ["ㄱ", "ㄲ", "ㄴ", "ㄷ", "ㄸ", "ㄹ", "ㅁ", "ㅂ", "ㅃ", "ㅅ", "ㅆ", "ㅇ", "ㅈ", "ㅉ", "ㅊ", "ㅋ", "ㅌ", "ㅍ", "ㅎ"] as const;
const MEDIALS = ["ㅏ", "ㅐ", "ㅑ", "ㅒ", "ㅓ", "ㅔ", "ㅕ", "ㅖ", "ㅗ", "ㅘ", "ㅙ", "ㅚ", "ㅛ", "ㅜ", "ㅝ", "ㅞ", "ㅟ", "ㅠ", "ㅡ", "ㅢ", "ㅣ"] as const;
const FINALS = ["", "ㄱ", "ㄲ", "ㄳ", "ㄴ", "ㄵ", "ㄶ", "ㄷ", "ㄹ", "ㄺ", "ㄻ", "ㄼ", "ㄽ", "ㄾ", "ㄿ", "ㅀ", "ㅁ", "ㅂ", "ㅄ", "ㅅ", "ㅆ", "ㅇ", "ㅈ", "ㅊ", "ㅋ", "ㅌ", "ㅍ", "ㅎ"] as const;

const INITIAL_INDEX = new Map<string, number>(INITIALS.map((value, index) => [value, index]));
const MEDIAL_INDEX = new Map<string, number>(MEDIALS.map((value, index) => [value, index]));
const FINAL_INDEX = new Map<string, number>(FINALS.map((value, index) => [value, index]));

const COMPOUND_INITIALS: Record<string, string> = {
  "ㄱㄱ": "ㄲ",
  "ㄷㄷ": "ㄸ",
  "ㅂㅂ": "ㅃ",
  "ㅅㅅ": "ㅆ",
  "ㅈㅈ": "ㅉ",
};
const SPLIT_INITIALS: Record<string, string> = Object.fromEntries(Object.entries(COMPOUND_INITIALS).map(([pair, value]) => [value, pair[0]]));

const COMPOUND_MEDIALS: Record<string, string> = {
  "ㅗㅏ": "ㅘ",
  "ㅗㅐ": "ㅙ",
  "ㅗㅣ": "ㅚ",
  "ㅜㅓ": "ㅝ",
  "ㅜㅔ": "ㅞ",
  "ㅜㅣ": "ㅟ",
  "ㅡㅣ": "ㅢ",
};
const SPLIT_MEDIALS: Record<string, [string, string]> = Object.fromEntries(
  Object.entries(COMPOUND_MEDIALS).map(([pair, value]) => [value, [pair[0], pair[1]]]),
) as Record<string, [string, string]>;

const COMPOUND_FINALS: Record<string, string> = {
  "ㄱㄱ": "ㄲ",
  "ㄱㅅ": "ㄳ",
  "ㄴㅈ": "ㄵ",
  "ㄴㅎ": "ㄶ",
  "ㄹㄱ": "ㄺ",
  "ㄹㅁ": "ㄻ",
  "ㄹㅂ": "ㄼ",
  "ㄹㅅ": "ㄽ",
  "ㄹㅌ": "ㄾ",
  "ㄹㅍ": "ㄿ",
  "ㄹㅎ": "ㅀ",
  "ㅂㅅ": "ㅄ",
  "ㅅㅅ": "ㅆ",
};
const SPLIT_FINALS: Record<string, [string, string]> = Object.fromEntries(
  Object.entries(COMPOUND_FINALS).map(([pair, value]) => [value, [pair[0], pair[1]]]),
) as Record<string, [string, string]>;

type Syllable = { initial: string; medial: string; final: string };

function decomposeSyllable(value: string): Syllable | null {
  const code = value.codePointAt(0);
  if (code === undefined || code < 0xac00 || code > 0xd7a3) return null;
  const offset = code - 0xac00;
  const initial = INITIALS[Math.floor(offset / 588)];
  const medial = MEDIALS[Math.floor((offset % 588) / 28)];
  const final = FINALS[offset % 28];
  return { initial, medial, final };
}

function composeSyllable(initial: string, medial: string, final = "") {
  const initialIndex = INITIAL_INDEX.get(initial);
  const medialIndex = MEDIAL_INDEX.get(medial);
  const finalIndex = FINAL_INDEX.get(final);
  if (initialIndex === undefined || medialIndex === undefined || finalIndex === undefined) return `${initial}${medial}${final}`;
  return String.fromCodePoint(0xac00 + initialIndex * 588 + medialIndex * 28 + finalIndex);
}

function splitLastCharacter(value: string) {
  const characters = Array.from(value);
  return { prefix: characters.slice(0, -1).join(""), last: characters.at(-1) ?? "" };
}

function isInitial(value: string) {
  return INITIAL_INDEX.has(value);
}

function isMedial(value: string) {
  return MEDIAL_INDEX.has(value);
}

function isFinal(value: string) {
  return value !== "" && FINAL_INDEX.has(value);
}

export function isHangulJamo(value: string) {
  return isInitial(value) || isMedial(value) || isFinal(value);
}

export function applyHangulKey(text: string, key: string) {
  if (!key) return text;
  if (Array.from(key).length !== 1 || !isHangulJamo(key)) return `${text}${key}`;

  const { prefix, last } = splitLastCharacter(text);
  if (!last) return key;
  const syllable = decomposeSyllable(last);

  if (isMedial(key)) {
    if (syllable) {
      if (!syllable.final) {
        const compound = COMPOUND_MEDIALS[`${syllable.medial}${key}`];
        return compound ? `${prefix}${composeSyllable(syllable.initial, compound)}` : `${text}${key}`;
      }

      const splitFinal = SPLIT_FINALS[syllable.final];
      const movableDoubleFinal = syllable.final === "ㄲ" || syllable.final === "ㅆ";
      const remainingFinal = movableDoubleFinal ? "" : splitFinal?.[0] ?? "";
      const movedInitial = movableDoubleFinal ? syllable.final : splitFinal?.[1] ?? syllable.final;
      if (!isInitial(movedInitial)) return `${text}${key}`;
      return `${prefix}${composeSyllable(syllable.initial, syllable.medial, remainingFinal)}${composeSyllable(movedInitial, key)}`;
    }

    if (isInitial(last)) return `${prefix}${composeSyllable(last, key)}`;
    if (isMedial(last)) {
      const compound = COMPOUND_MEDIALS[`${last}${key}`];
      return compound ? `${prefix}${compound}` : `${text}${key}`;
    }
    return `${text}${key}`;
  }

  if (syllable) {
    if (!syllable.final && isFinal(key)) return `${prefix}${composeSyllable(syllable.initial, syllable.medial, key)}`;
    if (syllable.final) {
      const compound = COMPOUND_FINALS[`${syllable.final}${key}`];
      if (compound) return `${prefix}${composeSyllable(syllable.initial, syllable.medial, compound)}`;
    }
    return `${text}${key}`;
  }

  if (isInitial(last)) {
    const compound = COMPOUND_INITIALS[`${last}${key}`];
    return compound ? `${prefix}${compound}` : `${text}${key}`;
  }
  return `${text}${key}`;
}

export function backspaceHangul(text: string) {
  const { prefix, last } = splitLastCharacter(text);
  if (!last) return text;
  const syllable = decomposeSyllable(last);

  if (syllable) {
    if (syllable.final) {
      const splitFinal = SPLIT_FINALS[syllable.final];
      return `${prefix}${composeSyllable(syllable.initial, syllable.medial, splitFinal?.[0] ?? "")}`;
    }
    const splitMedial = SPLIT_MEDIALS[syllable.medial];
    if (splitMedial) return `${prefix}${composeSyllable(syllable.initial, splitMedial[0])}`;
    return `${prefix}${syllable.initial}`;
  }

  if (SPLIT_MEDIALS[last]) return `${prefix}${SPLIT_MEDIALS[last][0]}`;
  if (SPLIT_FINALS[last]) return `${prefix}${SPLIT_FINALS[last][0]}`;
  if (SPLIT_INITIALS[last]) return `${prefix}${SPLIT_INITIALS[last]}`;
  return prefix;
}

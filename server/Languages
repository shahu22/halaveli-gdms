// ============================================================================
//  LANGUAGES
//  The set of languages the system supports for documents/templates.
//  - code:   short language code used as templates.lang and documents.lang
//  - en:     English name
//  - native: native-script name (shown in the picker as "English · 日本語")
//  - rtl:    right-to-left script (Arabic) — affects Word text direction
//  - font:   a font that can render this script in Word/PDF. Latin scripts use
//            the default; non-Latin need a script-capable font so characters
//            don't come out as empty boxes.
// ============================================================================
const LANGUAGES = [
  { code: "en", en: "English",  native: "English",  rtl: false, font: null },
  { code: "ru", en: "Russian",  native: "Русский",  rtl: false, font: null },        // Cyrillic works in most Latin fonts
  { code: "de", en: "German",   native: "Deutsch",  rtl: false, font: null },
  { code: "es", en: "Spanish",  native: "Español",  rtl: false, font: null },
  { code: "fr", en: "French",   native: "Français", rtl: false, font: null },
  { code: "zh", en: "Chinese",  native: "中文",      rtl: false, font: "Noto Sans CJK SC" },
  { code: "ja", en: "Japanese", native: "日本語",    rtl: false, font: "Noto Sans CJK JP" },
  { code: "ko", en: "Korean",   native: "한국어",    rtl: false, font: "Noto Sans CJK KR" },
  { code: "ar", en: "Arabic",   native: "العربية",   rtl: true,  font: "Noto Sans Arabic" },
];

const LANG_MAP = {};
LANGUAGES.forEach((l) => (LANG_MAP[l.code] = l));

function getLang(code) { return LANG_MAP[code] || LANG_MAP.en; }

module.exports = { LANGUAGES, LANG_MAP, getLang };

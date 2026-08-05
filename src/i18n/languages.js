// The languages the platform ships with.
//
// Adding one is a single entry here plus whatever translations you can supply;
// anything untranslated falls back to English automatically, so a new language
// never breaks a screen. Company names are stored per language against this
// same list (public.tenant_names), which is why it lives in its own file
// instead of inside the context.

export const supportedLanguages = [
  { code: 'ar', name: 'العربية', locale: 'ar-SA', dir: 'rtl' },
  { code: 'en', name: 'English', locale: 'en-US', dir: 'ltr' },
  { code: 'hi', name: 'हिन्दी', locale: 'hi-IN', dir: 'ltr' },
  { code: 'ur', name: 'اردو', locale: 'ur-PK', dir: 'rtl' },
  { code: 'tl', name: 'Filipino', locale: 'fil-PH', dir: 'ltr' },
];

export const languageCodes = supportedLanguages.map((language) => language.code);

export const getLanguage = (code) =>
  supportedLanguages.find((language) => language.code === code) || supportedLanguages[0];

export default supportedLanguages;

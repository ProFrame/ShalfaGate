// Modular translation registry.
//
// Every module drops one file in ./modules that default-exports a dictionary
// keyed by language code. Files are picked up automatically, so two modules
// never edit the same file and never collide.
//
//   // src/i18n/modules/chat.js
//   export default {
//     ar: { chat_title: 'الدردشة' },
//     en: { chat_title: 'Chat' },
//     hi: {}, ur: {}, tl: {},
//   };
//
// A key missing from a language falls back to English, then to the key itself,
// exactly like the rest of the platform.

import { supportedLanguages } from './languages';

const registered = import.meta.glob('./modules/*.js', { eager: true });

const emptyByLanguage = () =>
  supportedLanguages.reduce((acc, language) => ({ ...acc, [language.code]: {} }), {});

const merged = Object.values(registered).reduce((acc, module) => {
  const dictionary = module?.default ?? module;
  if (!dictionary || typeof dictionary !== 'object') return acc;

  supportedLanguages.forEach(({ code }) => {
    // English is the fallback source, so every language inherits it first.
    acc[code] = { ...acc[code], ...(dictionary.en || {}), ...(dictionary[code] || {}) };
  });
  return acc;
}, emptyByLanguage());

export const moduleTranslations = merged;

export { supportedLanguages };

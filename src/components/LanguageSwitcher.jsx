import { Languages } from 'lucide-react';
import { useLanguage } from '../context/LanguageContext';

const LanguageSwitcher = ({ className = '' }) => {
  const { lang, setLang, t, languages } = useLanguage();

  return (
    <label className={`language-switcher ${className}`.trim()}>
      <Languages size={17} aria-hidden="true" />
      <span className="sr-only">{t('language')}</span>
      <select value={lang} onChange={(event) => setLang(event.target.value)} aria-label={t('language')}>
        {languages.map((language) => (
          <option key={language.code} value={language.code}>{language.name}</option>
        ))}
      </select>
    </label>
  );
};

export default LanguageSwitcher;

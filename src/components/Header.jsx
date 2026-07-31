import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { FileText, Globe } from 'lucide-react';
import { useLanguage } from '../context/LanguageContext';
import { Link } from 'wouter';
import logo from '../assets/logo.png';

const languages = [
  { code: 'ar', name: 'العربية' },
  { code: 'en', name: 'English' },
  { code: 'hi', name: 'हिन्दी' },
  { code: 'ur', name: 'اردو' },
  { code: 'tl', name: 'Filipino' },
];

const Header = () => {
  const { lang, setLang, t } = useLanguage();
  const [isLangOpen, setIsLangOpen] = useState(false);

  return (
    <motion.header
      initial={{ y: -20, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      className="fixed top-0 left-0 right-0 z-50 flex items-center justify-between border-b border-stone-200 bg-white/90 px-6 py-4 shadow-sm backdrop-blur h-20"
    >
      <div className="flex items-center gap-4">
        <Link href="/">
          <img src={logo} alt="Shalfa Logo" className="h-12 md:h-14 object-contain" />
        </Link>
      </div>

      {/* Navigation and Login removed as requested */}

      <div className="flex items-center gap-4">
        {/* Home Button */}
        <Link
          href="/"
          className="flex items-center gap-2 px-3 py-1.5 rounded-md border border-stone-200 bg-white text-slate-700 transition-all hover:bg-stone-50"
        >
          <span className="text-xs font-medium">{t('home')}</span>
        </Link>
        <Link
          href="/app/forms"
          className="flex items-center gap-2 rounded-md bg-emerald-700 px-3 py-1.5 text-white transition-all hover:bg-emerald-800"
        >
          <FileText className="h-4 w-4" />
          <span className="text-xs font-medium">{t('forms')}</span>
        </Link>

        {/* Language Switcher */}
        <div className="relative">
          <button
            onClick={() => setIsLangOpen(!isLangOpen)}
            className="flex items-center gap-2 rounded-md border border-stone-200 bg-white px-3 py-1.5 text-slate-700 transition-all hover:bg-stone-50"
          >
            <Globe className="w-4 h-4 text-emerald-700" />
            <span className="text-xs font-medium uppercase">{lang}</span>
          </button>

          <AnimatePresence>
            {isLangOpen && (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 10 }}
                className={`absolute ${lang === 'ar' || lang === 'ur' ? 'left-0' : 'right-0'} mt-2 w-40 overflow-hidden rounded-lg border border-stone-200 bg-white shadow-xl`}
              >
                {languages.map((l) => (
                  <button
                    key={l.code}
                    onClick={() => {
                      setLang(l.code);
                      setIsLangOpen(false);
                    }}
                    className={`w-full px-4 py-2 text-left text-sm transition-colors hover:bg-stone-100 ${lang === l.code ? 'text-emerald-700 font-bold' : 'text-slate-600'}`}
                  >
                    {l.name}
                  </button>
                ))}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </motion.header>
  );
};

export default Header;

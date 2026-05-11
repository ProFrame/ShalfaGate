import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Globe, Menu, X } from 'lucide-react';
import { useLanguage } from '../context/LanguageContext';
import { Link } from 'react-router-dom';
import logo from '../assets/logo.png'; // Assuming the logo will be placed here

const languages = [
  { code: 'ar', name: 'العربية' },
  { code: 'en', name: 'English' },
  { code: 'hi', name: 'हिन्दी' },
  { code: 'ur', name: 'اردو' },
  { code: 'tl', name: 'Filipino' },
];

const Header = () => {
  const { lang, setLang, t, isRtl } = useLanguage();
  const [isLangOpen, setIsLangOpen] = useState(false);

  return (
    <motion.header 
      initial={{ y: -20, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      className="fixed top-0 left-0 right-0 z-50 flex items-center justify-between px-6 py-4 glass h-20"
    >
      <div className="flex items-center gap-4">
        <Link to="/">
          <img src={logo} alt="Shalfa Logo" className="h-12 md:h-14 object-contain" />
        </Link>
      </div>
      
      <nav className="hidden md:flex items-center gap-8">
        <Link to="/" className="text-sm font-medium text-slate-400 hover:text-white transition-colors">{t('about_link')}</Link>
        <Link to="/docs" className="text-sm font-medium text-slate-400 hover:text-white transition-colors">{t('services_link')}</Link>
        <Link to="#contact" className="text-sm font-medium text-slate-400 hover:text-white transition-colors">{t('contact_link')}</Link>
      </nav>

      <div className="flex items-center gap-4">
        {/* Language Switcher */}
        <div className="relative">
          <button 
            onClick={() => setIsLangOpen(!isLangOpen)}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 transition-all border border-white/10"
          >
            <Globe className="w-4 h-4 text-primary" />
            <span className="text-xs font-medium uppercase">{lang}</span>
          </button>

          <AnimatePresence>
            {isLangOpen && (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 10 }}
                className="absolute right-0 mt-2 w-40 glass rounded-xl overflow-hidden shadow-2xl"
              >
                {languages.map((l) => (
                  <button
                    key={l.code}
                    onClick={() => {
                      setLang(l.code);
                      setIsLangOpen(false);
                    }}
                    className={`w-full px-4 py-2 text-left text-sm hover:bg-primary/20 transition-colors ${lang === l.code ? 'text-primary font-bold' : 'text-slate-300'}`}
                  >
                    {l.name}
                  </button>
                ))}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <button className="hidden sm:block px-5 py-2 text-sm font-semibold text-white bg-primary rounded-full hover:bg-blue-600 transition-all shadow-lg shadow-blue-500/20">
          {t('login')}
        </button>
      </div>
    </motion.header>
  );
};

export default Header;

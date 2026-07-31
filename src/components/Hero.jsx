import { motion } from 'framer-motion';
import { ChevronRight } from 'lucide-react';
import { useLanguage } from '../context/LanguageContext';

const Hero = () => {
  const { t } = useLanguage();

  return (
    <section className="relative min-h-[70vh] flex items-center justify-center pt-24 overflow-hidden bg-stone-50">
      <div className="container mx-auto px-6 relative z-10 text-center">
        <motion.div
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.5 }}
          className="inline-flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 mb-8 text-xs font-medium text-emerald-800"
        >
          <span className="flex h-2 w-2 rounded-full bg-emerald-600 animate-pulse" />
          System Updated v2.0
          <ChevronRight className="w-3 h-3" />
        </motion.div>

        <motion.h1
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
          className="text-5xl md:text-7xl font-extrabold tracking-normal text-slate-950 mb-6"
        >
          {t('hero_title').split(' ').map((word, i) => (
            i === 0 ? word + ' ' : <span key={i} className="text-emerald-800">{word} </span>
          ))}
        </motion.h1>

        <motion.p
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3 }}
          className="max-w-2xl mx-auto text-lg md:text-xl text-slate-600 mb-10 leading-relaxed"
        >
          {t('hero_desc')}
        </motion.p>


      </div>

      {/* Decorative Elements */}
      <div className="absolute inset-x-0 bottom-0 h-px bg-stone-200" />
    </section>
  );
};

export default Hero;

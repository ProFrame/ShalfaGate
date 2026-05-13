import React from 'react';
import { motion } from 'framer-motion';
import { ArrowRight, ChevronRight } from 'lucide-react';
import { useLanguage } from '../context/LanguageContext';

const Hero = () => {
  const { t } = useLanguage();

  return (
    <section className="relative min-h-[80vh] flex items-center justify-center pt-20 overflow-hidden bg-mesh">
      <div className="container mx-auto px-6 relative z-10 text-center">
        <motion.div
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.5 }}
          className="inline-flex items-center gap-2 px-3 py-1 mb-8 rounded-full bg-white/5 border border-white/10 text-xs font-medium text-slate-300"
        >
          <span className="flex h-2 w-2 rounded-full bg-primary animate-pulse" />
          System Updated v2.0
          <ChevronRight className="w-3 h-3" />
        </motion.div>

        <motion.h1
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
          className="text-5xl md:text-7xl font-extrabold tracking-tight text-white mb-6"
        >
          {t('hero_title').split(' ').map((word, i) => (
            i === 0 ? word + ' ' : <span key={i} className="text-transparent bg-clip-text bg-gradient-to-r from-primary to-accent">{word} </span>
          ))}
        </motion.h1>

        <motion.p
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3 }}
          className="max-w-2xl mx-auto text-lg md:text-xl text-slate-400 mb-10 leading-relaxed"
        >
          {t('hero_desc')}
        </motion.p>


      </div>

      {/* Decorative Elements */}
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px] bg-primary/5 rounded-full blur-[120px] pointer-events-none" />
    </section>
  );
};

export default Hero;

import React from 'react';
import { motion } from 'framer-motion';
import { ArrowRight, ChevronRight } from 'lucide-react';

const Hero = () => {
  return (
    <section className="relative min-h-screen flex items-center justify-center pt-20 overflow-hidden bg-mesh">
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
          Your Gateway to <br />
          <span className="text-transparent bg-clip-text bg-gradient-to-r from-primary to-accent">
            Secure Management
          </span>
        </motion.h1>

        <motion.p
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3 }}
          className="max-w-2xl mx-auto text-lg md:text-xl text-slate-400 mb-10 leading-relaxed"
        >
          ShalfaGate provides a unified portal for administration, security, and operations. 
          Experience efficiency at its peak with our state-of-the-art platform.
        </motion.p>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.4 }}
          className="flex flex-col sm:flex-row items-center justify-center gap-4"
        >
          <button className="group flex items-center gap-2 px-8 py-4 bg-primary text-white font-bold rounded-xl hover:bg-blue-600 transition-all shadow-xl shadow-blue-500/25">
            Enter Dashboard
            <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
          </button>
          <button className="px-8 py-4 bg-white/5 text-white font-semibold rounded-xl border border-white/10 hover:bg-white/10 transition-all">
            Learn More
          </button>
        </motion.div>
      </div>

      {/* Decorative Elements */}
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px] bg-primary/5 rounded-full blur-[120px] pointer-events-none" />
    </section>
  );
};

export default Hero;

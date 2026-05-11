import React from 'react';
import { motion } from 'framer-motion';
import { Shield } from 'lucide-react';

const Header = () => {
  return (
    <motion.header 
      initial={{ y: -20, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      className="fixed top-0 left-0 right-0 z-50 flex items-center justify-between px-6 py-4 glass"
    >
      <div className="flex items-center gap-2">
        <Shield className="w-8 h-8 text-primary" />
        <span className="text-xl font-bold tracking-tight text-white">ShalfaGate</span>
      </div>
      
      <nav className="hidden md:flex items-center gap-8">
        <a href="#about" className="text-sm font-medium text-slate-400 hover:text-white transition-colors">About</a>
        <a href="#services" className="text-sm font-medium text-slate-400 hover:text-white transition-colors">Services</a>
        <a href="#contact" className="text-sm font-medium text-slate-400 hover:text-white transition-colors">Contact</a>
      </nav>

      <button className="px-5 py-2 text-sm font-semibold text-white bg-primary rounded-full hover:bg-blue-600 transition-all shadow-lg shadow-blue-500/20">
        Login
      </button>
    </motion.header>
  );
};

export default Header;

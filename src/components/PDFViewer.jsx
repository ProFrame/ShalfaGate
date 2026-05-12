import React from 'react';
import { motion } from 'framer-motion';
import { ChevronLeft, ExternalLink, Download } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useLanguage } from '../context/LanguageContext';

import { getEmbedUrl } from '../utils/urlHelper';

const PDFViewer = ({ titleKey, url }) => {
  const navigate = useNavigate();
  const { t } = useLanguage();
  
  const embedUrl = getEmbedUrl(url);

  const handleDownload = () => {
    window.open(url, '_blank');
  };

  const handleOpenNewWindow = () => {
    window.open(url, '_blank');
  };

  return (
    <motion.div 
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="min-h-screen bg-[#030712] pt-24 pb-12 px-6"
    >
      <div className="container mx-auto max-w-6xl h-[calc(100vh-160px)] flex flex-col gap-6">
        <div className="flex items-center justify-between">
          <button 
            onClick={() => navigate(-1)}
            className="flex items-center gap-2 text-slate-400 hover:text-white transition-colors"
          >
            <ChevronLeft className="w-5 h-5" />
            <span>{t('back')}</span>
          </button>
          <h1 className="text-2xl font-bold text-white">{t(titleKey)}</h1>
          <div className="flex items-center gap-3">
            <button 
              onClick={handleOpenNewWindow}
              title={t('open_new_tab')}
              className="p-2 glass rounded-lg hover:text-primary transition-colors flex items-center gap-2"
            >
              <ExternalLink className="w-5 h-5" />
              <span className="text-xs hidden md:inline">{t('open_new_tab')}</span>
            </button>
            <button 
              onClick={handleDownload}
              title={t('download')}
              className="p-2 glass rounded-lg hover:text-primary transition-colors flex items-center gap-2"
            >
              <Download className="w-5 h-5" />
              <span className="text-xs hidden md:inline">{t('download')}</span>
            </button>
          </div>
        </div>

        <div className="flex-1 glass rounded-3xl overflow-hidden relative border border-white/10 shadow-2xl">
          <iframe 
            src={embedUrl} 
            className="w-full h-full border-none"
            allow="autoplay"
          ></iframe>
        </div>
      </div>
    </motion.div>
  );
};

export default PDFViewer;

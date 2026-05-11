import React from 'react';
import { motion } from 'framer-motion';
import { ChevronLeft, Download, ExternalLink } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

const PDFViewer = ({ title, url }) => {
  const navigate = useNavigate();
  // Convert Google Drive view link to preview link for embedding
  const embedUrl = url.replace('/view?pli=1', '/preview').replace('/view', '/preview');

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
            <span>Back</span>
          </button>
          <h1 className="text-2xl font-bold text-white">{title}</h1>
          <div className="flex items-center gap-3">
            <a href={url} target="_blank" rel="noopener noreferrer" className="p-2 glass rounded-lg hover:text-primary transition-colors">
              <ExternalLink className="w-5 h-5" />
            </a>
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

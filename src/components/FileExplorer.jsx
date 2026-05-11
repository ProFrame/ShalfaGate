import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { File, ChevronRight, Eye, Download, Search } from 'lucide-react';

const FileExplorer = ({ title, items = [] }) => {
  const [selectedItem, setSelectedItem] = useState(items[0] || null);
  const [searchTerm, setSearchTerm] = useState('');

  const filteredItems = items.filter(item => 
    item.name.toLowerCase().includes(searchTerm.toLowerCase())
  );

  return (
    <div className="min-h-screen bg-[#030712] pt-28 pb-12 px-6">
      <div className="container mx-auto h-[calc(100vh-180px)] flex flex-col md:flex-row gap-8">
        
        {/* Sidebar */}
        <div className="w-full md:w-1/3 flex flex-col gap-4">
          <div className="flex items-center justify-between mb-2">
            <h1 className="text-2xl font-bold text-white">{title}</h1>
            <span className="px-3 py-1 bg-white/5 rounded-full text-xs text-slate-400 border border-white/10">
              {filteredItems.length} Files
            </span>
          </div>
          
          <div className="relative mb-4">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
            <input 
              type="text" 
              placeholder="Search documents..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-10 pr-4 py-3 bg-white/5 border border-white/10 rounded-xl focus:outline-none focus:border-primary/50 transition-colors text-sm"
            />
          </div>

          <div className="flex-1 glass rounded-2xl overflow-y-auto custom-scrollbar border border-white/10">
            {filteredItems.map((item) => (
              <button
                key={item.id}
                onClick={() => setSelectedItem(item)}
                className={`w-full flex items-center gap-4 p-4 text-left transition-all border-b border-white/5 hover:bg-white/5 ${selectedItem?.id === item.id ? 'bg-primary/10 border-l-4 border-l-primary' : ''}`}
              >
                <div className={`p-2 rounded-lg ${selectedItem?.id === item.id ? 'bg-primary/20 text-primary' : 'bg-white/5 text-slate-400'}`}>
                  <File className="w-5 h-5" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className={`text-sm font-semibold truncate ${selectedItem?.id === item.id ? 'text-white' : 'text-slate-300'}`}>
                    {item.name}
                  </p>
                  <p className="text-xs text-slate-500 mt-1">{item.date} • {item.size}</p>
                </div>
                <ChevronRight className={`w-4 h-4 text-slate-600 transition-transform ${selectedItem?.id === item.id ? 'rotate-90 text-primary' : ''}`} />
              </button>
            ))}
          </div>
        </div>

        {/* Main Preview Area */}
        <div className="flex-1 glass rounded-3xl overflow-hidden border border-white/10 flex flex-col">
          <AnimatePresence mode="wait">
            {selectedItem ? (
              <motion.div
                key={selectedItem.id}
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                className="h-full flex flex-col"
              >
                <div className="p-6 border-b border-white/5 flex items-center justify-between bg-white/[0.02]">
                  <div>
                    <h2 className="text-xl font-bold text-white">{selectedItem.name}</h2>
                    <p className="text-sm text-slate-400 mt-1">Uploaded on {selectedItem.date}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button className="flex items-center gap-2 px-4 py-2 glass rounded-xl hover:bg-white/10 transition-all text-sm font-medium">
                      <Download className="w-4 h-4" />
                      Download
                    </button>
                  </div>
                </div>
                
                <div className="flex-1 bg-black/40 flex items-center justify-center p-8">
                  {selectedItem.type === 'image' ? (
                    <img src={selectedItem.url} alt={selectedItem.name} className="max-w-full max-h-full object-contain rounded-lg shadow-2xl" />
                  ) : (
                    <div className="text-center">
                      <File className="w-20 h-20 text-slate-700 mx-auto mb-6" />
                      <p className="text-slate-400 mb-6">Preview for {selectedItem.name}</p>
                      <button className="px-8 py-3 bg-primary text-white font-bold rounded-xl shadow-xl shadow-blue-500/20">
                        Open in New Tab
                      </button>
                    </div>
                  )}
                </div>
              </motion.div>
            ) : (
              <div className="h-full flex flex-center flex-col items-center justify-center text-slate-500">
                <Eye className="w-16 h-16 mb-4 opacity-20" />
                <p>Select a file to preview</p>
              </div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
};

export default FileExplorer;

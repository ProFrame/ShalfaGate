import { ExternalLink } from 'lucide-react';
import { getEmbedUrl } from '../utils/urlHelper';

const FileExplorer = ({ titleKey, items = [] }) => {
  const [selectedItem, setSelectedItem] = useState(items[0] || null);
  const [searchTerm, setSearchTerm] = useState('');
  const { t } = useLanguage();

  const filteredItems = items.filter(item => 
    item.name.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const handleOpenNewWindow = (url) => {
    window.open(url, '_blank');
  };

  return (
    <div className="min-h-screen bg-[#030712] pt-28 pb-12 px-6">
      <div className="container mx-auto h-[calc(100vh-180px)] flex flex-col md:flex-row gap-8">
        
        {/* Sidebar */}
        <div className="w-full md:w-1/3 flex flex-col gap-4">
          <div className="flex items-center justify-between mb-2">
            <h1 className="text-2xl font-bold text-white">{t(titleKey)}</h1>
            <span className="px-3 py-1 bg-white/5 rounded-full text-xs text-slate-400 border border-white/10">
              {filteredItems.length} {t('files_count')}
            </span>
          </div>
          
          <div className="relative mb-4">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
            <input 
              type="text" 
              placeholder={t('search_placeholder')}
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
                  <div className="min-w-0">
                    <h2 className="text-xl font-bold text-white truncate">{selectedItem.name}</h2>
                    <p className="text-sm text-slate-400 mt-1">{selectedItem.date}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button 
                      onClick={() => handleOpenNewWindow(selectedItem.url)}
                      className="p-2 glass rounded-lg hover:text-primary transition-all text-slate-400"
                      title={t('open_new_tab')}
                    >
                      <ExternalLink className="w-5 h-5" />
                    </button>
                    <button 
                      onClick={() => handleOpenNewWindow(selectedItem.url)}
                      className="flex items-center gap-2 px-4 py-2 bg-primary/20 text-primary rounded-xl hover:bg-primary/30 transition-all text-sm font-medium"
                    >
                      <Download className="w-4 h-4" />
                      <span className="hidden sm:inline">{t('download')}</span>
                    </button>
                  </div>
                </div>
                
                <div className="flex-1 bg-black/20 relative">
                  {selectedItem.type === 'image' ? (
                    <div className="w-full h-full p-8 flex items-center justify-center">
                      <img src={selectedItem.url} alt={selectedItem.name} className="max-w-full max-h-full object-contain rounded-lg shadow-2xl" />
                    </div>
                  ) : (
                    <iframe 
                      src={getEmbedUrl(selectedItem.url)} 
                      className="w-full h-full border-none"
                      allow="autoplay"
                    />
                  )}
                </div>
              </motion.div>
            ) : (
              <div className="h-full flex flex-center flex-col items-center justify-center text-slate-500">
                <Eye className="w-16 h-16 mb-4 opacity-20" />
                <p>{t('select_file')}</p>
              </div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
};

export default FileExplorer;

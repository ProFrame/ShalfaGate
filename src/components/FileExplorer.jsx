import { useMemo, useState } from 'react';
import { Download, ExternalLink, Eye, FileText, Search, X } from 'lucide-react';
import { useLanguage } from '../context/LanguageContext';
import { getEmbedUrl } from '../utils/urlHelper';
import { pickLocalized } from '../utils/localize';

// Walks name_{lang} → name_2 → name_en → name_1 → name_ar → name, so a title
// the publisher left blank in one language still reads in another instead of
// falling straight back to the Arabic column.
const getItemName = (item, lang) => pickLocalized(item, 'name', lang);

const FileExplorer = ({ titleKey, items = [] }) => {
  const [selectedId, setSelectedId] = useState(undefined);
  const [searchTerm, setSearchTerm] = useState('');
  const { t, lang } = useLanguage();
  const selectedItem = selectedId === null
    ? null
    : items.find((item) => item.id === selectedId) || items[0] || null;
  const filteredItems = useMemo(() => {
    const query = searchTerm.trim().toLocaleLowerCase();
    if (!query) return items;
    return items.filter((item) => getItemName(item, lang).toLocaleLowerCase().includes(query));
  }, [items, lang, searchTerm]);

  const openItem = (url) => window.open(url, '_blank', 'noopener,noreferrer');
  const isImage = selectedItem && (/^(image|img)$/i.test(selectedItem.type || '') || /\.(jpg|jpeg|png|gif|webp)$/i.test(selectedItem.url || ''));

  return (
    <main className="app-main content-library-page">
      <section className="content-library-heading">
        <div>
          <span className="section-kicker">{t('approved_content')}</span>
          <h1>{t(titleKey)}</h1>
          <p>{t('approved_content_text')}</p>
        </div>
        <span className="content-count"><strong>{items.length}</strong>{t('files_count')}</span>
      </section>

      <section className={`content-library-layout ${selectedItem ? 'has-selection' : ''}`}>
        <aside className="content-browser">
          <label className="content-search">
            <Search size={18} />
            <input value={searchTerm} onChange={(event) => setSearchTerm(event.target.value)} placeholder={t('search_placeholder')} />
            {searchTerm && <button type="button" onClick={() => setSearchTerm('')} aria-label={t('action_clear')}><X size={16} /></button>}
          </label>
          <div className="content-file-list">
            {filteredItems.length ? filteredItems.map((item) => (
              <button key={item.id} className={selectedItem?.id === item.id ? 'active' : ''} onClick={() => setSelectedId(item.id)}>
                <span className="content-file-icon"><FileText size={20} /></span>
                <span><b>{getItemName(item, lang)}</b><small>{item.date || t('last_updated_today')} {item.size ? `· ${item.size}` : ''}</small></span>
              </button>
            )) : <div className="content-empty"><Search size={30} /><span>{t('no_results')}</span></div>}
          </div>
        </aside>

        <div className="content-preview">
          {selectedItem ? (
            <>
              <header>
                <button type="button" className="icon-button content-mobile-back" onClick={() => setSelectedId(null)} aria-label={t('back_to_files')}><X /></button>
                <div><span>{t('file_preview')}</span><h2>{getItemName(selectedItem, lang)}</h2><small>{selectedItem.date}</small></div>
                <div className="content-preview-actions">
                  <button className="icon-button" onClick={() => openItem(selectedItem.url)} title={t('open_new_tab')}><ExternalLink /></button>
                  <button className="primary-button" onClick={() => openItem(selectedItem.url)}><Download size={17} /> {t('download')}</button>
                </div>
              </header>
              <div className="content-preview-body">
                {isImage ? (
                  <img src={selectedItem.url} alt={getItemName(selectedItem, lang)} />
                ) : (
                  <iframe title={getItemName(selectedItem, lang)} src={getEmbedUrl(selectedItem.url)} allow="autoplay" />
                )}
              </div>
            </>
          ) : (
            <div className="content-preview-empty"><Eye /><p>{t('select_file')}</p></div>
          )}
        </div>
      </section>
    </main>
  );
};

export default FileExplorer;

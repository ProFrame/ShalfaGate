import { useEffect, useRef, useState } from 'react';
import {
  Download, File, FileText, ImageIcon, Paperclip, Plus, Printer, RotateCw,
  Tag, Upload, X, ZoomIn, ZoomOut, ChevronLeft, ChevronRight, ExternalLink,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { useLanguage } from '../../context/LanguageContext';
import { formatBytes, formatDateTime } from '../../utils/localize';
import { attachFile, listAttachments, markAttachmentForRemoval } from '../../lib/platformCore/attachments';
import './attachmentsPanel.css';

/** Icon that matches the file family — same three-way split every other module here uses. */
const fileGlyph = (mime) => {
  const type = String(mime || '');
  if (type.startsWith('image/')) return <ImageIcon />;
  if (type.includes('pdf') || type.startsWith('text/')) return <FileText />;
  return <File />;
};

const isImage = (mime) => String(mime || '').startsWith('image/');

/**
 * Full-screen preview: zoom/rotate for images, open/download for everything
 * else (a PDF or Office file has no honest in-page zoom/rotate without a
 * rendering library this project does not carry — offering "open" instead of
 * faking those controls is the complete, correct behaviour for that case).
 */
const AttachmentPreview = ({ attachments, index, onIndex, onClose, t }) => {
  // Remounted by the parent on every index change (key={previewIndex}), so
  // zoom/rotation start fresh for each attachment without an effect that
  // would otherwise need to reset them itself.
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const item = attachments[index];
  const shellRef = useRef(null);
  const closeButtonRef = useRef(null);

  // A dialog that claims aria-modal="true" has to behave like one: move
  // focus in on open (so a keyboard/screen-reader user isn't left on
  // whatever was focused behind it) and trap Tab within it, restoring focus
  // to whatever opened it when it closes.
  useEffect(() => {
    const previouslyFocused = document.activeElement;
    closeButtonRef.current?.focus();
    return () => { previouslyFocused?.focus?.(); };
  }, []);

  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') { onClose(); return; }
      if (event.key === 'ArrowRight') onIndex((index + 1) % attachments.length);
      if (event.key === 'ArrowLeft') onIndex((index - 1 + attachments.length) % attachments.length);
      if (event.key === 'Tab') {
        const focusable = shellRef.current?.querySelectorAll('button, a[href]');
        if (!focusable?.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index, attachments.length, onIndex, onClose]);

  if (!item) return null;
  const canRasterPreview = isImage(item.mime_type);

  const handlePrint = () => {
    const win = window.open(item.url, '_blank', 'noopener,noreferrer');
    if (win) win.addEventListener('load', () => win.print());
  };

  return (
    <motion.div
      className="attachments-preview-backdrop"
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      onClick={onClose} role="presentation"
    >
      <motion.div
        ref={shellRef}
        className="attachments-preview-shell"
        initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.97 }}
        onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-label={item.file_name}
      >
        <header className="attachments-preview-header">
          <div className="attachments-preview-title">
            {fileGlyph(item.mime_type)}
            <span>{item.file_name}</span>
          </div>
          <button ref={closeButtonRef} type="button" className="icon-button" onClick={onClose} aria-label={t('att_preview_close')}>
            <X />
          </button>
        </header>

        <div className="attachments-preview-body">
          {attachments.length > 1 && (
            <button
              type="button" className="attachments-preview-nav prev"
              onClick={() => onIndex((index - 1 + attachments.length) % attachments.length)}
              aria-label={t('att_preview_previous')}
            >
              <ChevronLeft />
            </button>
          )}

          {canRasterPreview ? (
            <img
              src={item.url}
              alt={item.file_name}
              className="attachments-preview-image"
              style={{ transform: `scale(${zoom}) rotate(${rotation}deg)` }}
            />
          ) : (
            <div className="attachments-preview-fallback">
              {fileGlyph(item.mime_type)}
              <p>{t('att_preview_unavailable')}</p>
            </div>
          )}

          {attachments.length > 1 && (
            <button
              type="button" className="attachments-preview-nav next"
              onClick={() => onIndex((index + 1) % attachments.length)}
              aria-label={t('att_preview_next')}
            >
              <ChevronRight />
            </button>
          )}
        </div>

        <footer className="attachments-preview-toolbar">
          {canRasterPreview && (
            <>
              <button type="button" className="icon-button" onClick={() => setZoom((z) => Math.min(z + 0.25, 3))} aria-label={t('att_preview_zoom_in')}><ZoomIn /></button>
              <button type="button" className="icon-button" onClick={() => setZoom((z) => Math.max(z - 0.25, 0.5))} aria-label={t('att_preview_zoom_out')}><ZoomOut /></button>
              <button type="button" className="icon-button" onClick={() => setRotation((r) => (r + 90) % 360)} aria-label={t('att_preview_rotate')}><RotateCw /></button>
            </>
          )}
          <a className="icon-button" href={item.url} download={item.file_name} aria-label={t('att_preview_download')}><Download /></a>
          <button type="button" className="icon-button" onClick={handlePrint} aria-label={t('att_preview_print')}><Printer /></button>
          <a className="icon-button" href={item.url} target="_blank" rel="noopener noreferrer" aria-label={t('att_preview_open')}><ExternalLink /></a>
        </footer>
      </motion.div>
    </motion.div>
  );
};

/**
 * Shared attachments UI: a card grid, upload, mark-for-removal (never a hard
 * delete or replace — the file stays visible, just flagged, per
 * FourthUpdate.md's rule), and a full preview with zoom/rotate/download/
 * print/open and next/previous between attachments.
 *
 * @param {{ tenantId: string, entityType: string, entityId: string, area?: string, layer?: 'Core'|'Extended', readOnly?: boolean, listFn?: (entityType: string, entityId: string) => Promise<{data, error}> }} props
 *   `listFn` defaults to the generic Attachment Framework read (owner/creator/
 *   Storage.Manage only). A module whose record has its own wider audience —
 *   e.g. any current participant of a form, not just who uploaded the file —
 *   passes its own wrapping read here instead (see FormsPortal.jsx).
 */
const AttachmentsPanel = ({ tenantId, entityType, entityId, area = 'attachments', layer = 'Extended', readOnly = false, listFn = listAttachments }) => {
  const { t, lang } = useLanguage();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [previewIndex, setPreviewIndex] = useState(null);
  const inputRef = useRef(null);

  const applyLoaded = ({ data, error: loadError }) => {
    setItems(data || []);
    setError(loadError ? t('att_err_load_failed') : '');
    setLoading(false);
  };

  // Explicit reload after a user action (upload, mark-for-removal) — fine to
  // set loading synchronously here, this runs from an event handler, not an
  // effect.
  const reload = async () => {
    setLoading(true);
    applyLoaded(await listFn(entityType, entityId));
  };

  // Initial/entity-change load: `loading` already starts true, so the effect
  // itself never calls setState synchronously — only the async .then() does,
  // same pattern as every other fetch-on-mount screen in this codebase (see
  // e.g. NotesBoard.jsx).
  useEffect(() => {
    if (!entityType || !entityId) return undefined;
    let cancelled = false;
    listFn(entityType, entityId).then((result) => { if (!cancelled) applyLoaded(result); });
    return () => { cancelled = true; };
    // listFn is expected to be referentially stable (a module-level function,
    // not an inline arrow) — see FormsPortal.jsx's formAttachmentList usage.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityType, entityId]);

  const onPick = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setUploading(true);
    setError('');
    const { error: attachError } = await attachFile({ file, tenantId, area, layer, entityType, entityId });
    setUploading(false);
    if (attachError) { setError(t('att_err_upload_failed')); return; }
    await reload();
  };

  const toggleRemoval = async (item) => {
    const nextMarked = !item.marked_for_removal;
    const { error: markError } = await markAttachmentForRemoval(item.id, nextMarked);
    if (markError) { setError(t('att_err_mark_failed')); return; }
    // A pure flag flip on an already-known row — no new data to fetch,
    // so update locally instead of re-fetching (and re-signing every URL
    // for) the whole list (closing-audit performance finding).
    setItems((current) => current.map((row) => (
      row.id === item.id ? { ...row, marked_for_removal: nextMarked } : row
    )));
  };

  return (
    <div className="attachments-panel">
      <div className="attachments-panel-header">
        <h4><Paperclip /> {t('att_panel_title')} {items.length > 0 && <span className="attachments-count">{items.length}</span>}</h4>
        {!readOnly && (
          <>
            <button type="button" className="secondary-button" disabled={uploading} onClick={() => inputRef.current?.click()}>
              {uploading ? <Upload className="spin" /> : <Plus />} {uploading ? t('att_uploading') : t('att_add')}
            </button>
            <input ref={inputRef} hidden type="file" onChange={onPick} />
          </>
        )}
      </div>

      {error && <p className="attachments-error">{error}</p>}

      {!loading && items.length === 0 && <p className="attachments-empty">{t('att_empty')}</p>}

      <div className="attachments-grid">
        <AnimatePresence>
          {items.map((item, index) => (
            <motion.div
              key={item.id}
              layout initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
              className={`attachment-card${item.marked_for_removal ? ' marked' : ''}`}
            >
              <button type="button" className="attachment-card-open" onClick={() => setPreviewIndex(index)}>
                {isImage(item.mime_type) && item.url
                  ? <img src={item.url} alt={item.file_name} className="attachment-thumb" />
                  : <span className="attachment-thumb attachment-thumb-glyph">{fileGlyph(item.mime_type)}</span>}
                <span className="attachment-name" title={item.file_name}>{item.file_name}</span>
                <span className="attachment-meta">{formatBytes(item.file_size, lang)} · {formatDateTime(item.created_on, lang)}</span>
                {item.created_by_name && (
                  <span className="attachment-meta">{t('att_uploaded_by')} {item.created_by_name}</span>
                )}
              </button>
              {item.marked_for_removal && <span className="attachment-flag"><Tag size={12} /> {t('att_marked_badge')}</span>}
              {!readOnly && (
                <button
                  type="button"
                  className={`attachment-mark-button${item.marked_for_removal ? ' active' : ''}`}
                  onClick={() => toggleRemoval(item)}
                >
                  {item.marked_for_removal ? t('att_unmark_removal') : t('att_mark_for_removal')}
                </button>
              )}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      <AnimatePresence>
        {previewIndex !== null && items[previewIndex] && (
          <AttachmentPreview
            key={previewIndex}
            attachments={items}
            index={previewIndex}
            onIndex={setPreviewIndex}
            onClose={() => setPreviewIndex(null)}
            t={t}
          />
        )}
      </AnimatePresence>
    </div>
  );
};

export default AttachmentsPanel;

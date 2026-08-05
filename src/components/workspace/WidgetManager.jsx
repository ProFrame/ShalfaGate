import { useEffect, useId, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { LayoutDashboard, RotateCcw, SlidersHorizontal, X } from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { WIDGET_WIDTHS } from '../../data/workspaceService';

const WidgetRow = ({ widget, onToggleVisible, onWidthChange }) => {
  const { t } = useLanguage();
  const selectId = useId();
  const Icon = widget.Icon || LayoutDashboard;
  const name = widget.title;

  return (
    <li className={`ws-manager-row ${widget.is_visible ? '' : 'is-off'}`}>
      <div>
        <span className="ws-widget-icon" aria-hidden="true"><Icon /></span>
        <span>
          <b>{name}</b>
          {widget.description && <small>{widget.description}</small>}
        </span>
        <button
          type="button"
          role="switch"
          className="ws-switch"
          aria-checked={Boolean(widget.is_visible)}
          aria-label={widget.is_visible ? t('ws_hide_widget', { name }) : t('ws_show_widget', { name })}
          title={t('ws_visibility')}
          onClick={() => onToggleVisible(widget.code)}
        >
          <span aria-hidden="true" />
        </button>
      </div>

      <div className="ws-manager-width">
        <label htmlFor={selectId}>{t('ws_width')}</label>
        <select
          id={selectId}
          className="form-input"
          value={widget.width}
          aria-label={t('ws_widget_width_for', { name })}
          onChange={(event) => onWidthChange(widget.code, event.target.value)}
        >
          {WIDGET_WIDTHS.map((width) => (
            <option key={width} value={width}>{t(`ws_width_${width.toLowerCase()}`)}</option>
          ))}
        </select>
      </div>
    </li>
  );
};

const ManagerPanel = ({ widgets, onClose, onToggleVisible, onWidthChange, onReset }) => {
  const { t, isRtl } = useLanguage();
  const titleId = useId();
  const panelRef = useRef(null);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    const onKeyDown = (event) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKeyDown);
    panelRef.current?.focus();
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const visibleCount = widgets.filter((widget) => widget.is_visible).length;

  return (
    <motion.aside
      ref={panelRef}
      tabIndex={-1}
      className="ws-manager"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      initial={{ x: isRtl ? '-100%' : '100%' }}
      animate={{ x: 0 }}
      exit={{ x: isRtl ? '-100%' : '100%' }}
      transition={{ type: 'spring', stiffness: 320, damping: 34 }}
    >
      <header className="ws-manager-head">
        <span className="ws-widget-icon" aria-hidden="true"><SlidersHorizontal /></span>
        <div>
          <span className="section-kicker">{t('ws_customize')}</span>
          <h2 id={titleId}>{t('ws_customize_title')}</h2>
          <p>{t('ws_customize_intro')}</p>
        </div>
        <button type="button" className="ws-tool" onClick={onClose} aria-label={t('ws_close_panel')} title={t('action_close')}>
          <X aria-hidden="true" />
        </button>
      </header>

      {widgets.length === 0 ? (
        <p className="ws-empty">{t('ws_catalogue_empty')}</p>
      ) : (
        <ul className="ws-manager-list">
          {widgets.map((widget) => (
            <WidgetRow
              key={widget.code}
              widget={widget}
              onToggleVisible={onToggleVisible}
              onWidthChange={onWidthChange}
            />
          ))}
        </ul>
      )}

      <footer className="ws-manager-foot">
        <p className="field-note">{t('ws_visible_count', { count: visibleCount, total: widgets.length })}</p>
        {confirming ? (
          <div className="ws-manager-confirm">
            <p>{t('ws_reset_question')}</p>
            <div>
              <button type="button" className="secondary-button" onClick={() => setConfirming(false)}>{t('action_cancel')}</button>
              <button type="button" className="primary-button" onClick={() => { setConfirming(false); onReset(); }}>
                {t('action_confirm')}
              </button>
            </div>
          </div>
        ) : (
          <button type="button" className="secondary-button" onClick={() => setConfirming(true)}>
            <RotateCcw size={16} aria-hidden="true" /> {t('ws_reset')}
          </button>
        )}
      </footer>
    </motion.aside>
  );
};

/**
 * The "Customize" panel: the whole catalogue with a visibility switch and a
 * width per card, plus the way back to the defaults. Cards belonging to a
 * switched-off module never reach this list — the dashboard filters them out
 * before they get here.
 */
const WidgetManager = ({ open, widgets, onClose, onToggleVisible, onWidthChange, onReset }) => {
  const { t } = useLanguage();

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.button
            type="button"
            className="ws-manager-backdrop"
            aria-label={t('ws_close_panel')}
            onClick={onClose}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          />
          <ManagerPanel
            widgets={widgets}
            onClose={onClose}
            onToggleVisible={onToggleVisible}
            onWidthChange={onWidthChange}
            onReset={onReset}
          />
        </>
      )}
    </AnimatePresence>
  );
};

export default WidgetManager;

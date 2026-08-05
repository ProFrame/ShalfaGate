import { useId } from 'react';
import {
  ChevronDown, ChevronUp, Columns2, EyeOff, GripVertical, LayoutDashboard, Pin, PinOff,
} from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';

/**
 * The chrome every home page card wears: a drag handle, a title, and the four
 * controls that make the card the user's own — pin, width, collapse, remove.
 *
 * The frame owns no state. Every control reports upwards so one place (the
 * dashboard) persists the whole board and can roll it back on failure.
 */
const WidgetFrame = ({
  widget,
  isDragging = false,
  dragHandleProps = {},
  hintId,
  onToggleCollapse,
  onTogglePin,
  onCycleWidth,
  onHide,
  children,
}) => {
  const { t } = useLanguage();
  const bodyId = useId();
  const Icon = widget.Icon || LayoutDashboard;
  const name = widget.title;
  const widthKey = String(widget.width || 'Half').toLowerCase();

  const className = [
    'ws-widget',
    isDragging ? 'is-dragging' : '',
    widget.is_collapsed ? 'is-collapsed' : '',
    widget.is_pinned ? 'is-pinned' : '',
  ].filter(Boolean).join(' ');

  return (
    <section className={className} aria-label={name}>
      <header className="ws-widget-head">
        <button
          type="button"
          className="ws-tool ws-drag-handle"
          aria-label={t('ws_drag_handle', { name })}
          title={t('ws_drag_handle', { name })}
          aria-describedby={hintId}
          {...dragHandleProps}
        >
          <GripVertical aria-hidden="true" />
        </button>

        <div className="ws-widget-title">
          <span className="ws-widget-icon" aria-hidden="true"><Icon /></span>
          <h2>{name}</h2>
          {widget.is_pinned && <span className="ws-pin-badge"><Pin aria-hidden="true" size={11} />{t('ws_pinned')}</span>}
        </div>

        <div className="ws-widget-tools">
          <button
            type="button"
            className={`ws-tool ${widget.is_pinned ? 'is-on' : ''}`}
            aria-pressed={Boolean(widget.is_pinned)}
            aria-label={widget.is_pinned ? t('ws_unpin', { name }) : t('ws_pin', { name })}
            title={widget.is_pinned ? t('ws_unpin', { name }) : t('ws_pin', { name })}
            onClick={() => onTogglePin(widget.code)}
          >
            {widget.is_pinned ? <PinOff aria-hidden="true" /> : <Pin aria-hidden="true" />}
          </button>

          <button
            type="button"
            className="ws-tool ws-width-tool"
            aria-label={t('ws_change_width', { name })}
            title={t(`ws_width_${widthKey}`)}
            onClick={() => onCycleWidth(widget.code)}
          >
            <Columns2 aria-hidden="true" />
            <b aria-hidden="true">{t(`ws_width_short_${widthKey}`)}</b>
            <span className="sr-only">{t(`ws_width_${widthKey}`)}</span>
          </button>

          <button
            type="button"
            className="ws-tool"
            aria-expanded={!widget.is_collapsed}
            aria-controls={bodyId}
            aria-label={widget.is_collapsed ? t('ws_expand', { name }) : t('ws_collapse', { name })}
            title={widget.is_collapsed ? t('ws_expand', { name }) : t('ws_collapse', { name })}
            onClick={() => onToggleCollapse(widget.code)}
          >
            {widget.is_collapsed ? <ChevronDown aria-hidden="true" /> : <ChevronUp aria-hidden="true" />}
          </button>

          <button
            type="button"
            className="ws-tool"
            aria-label={t('ws_hide', { name })}
            title={t('ws_hide', { name })}
            onClick={() => onHide(widget.code)}
          >
            <EyeOff aria-hidden="true" />
          </button>
        </div>
      </header>

      {/* A collapsed card keeps its header and nothing else. */}
      {!widget.is_collapsed && <div className="ws-widget-body" id={bodyId}>{children}</div>}
    </section>
  );
};

export default WidgetFrame;

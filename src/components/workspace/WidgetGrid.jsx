import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { useLanguage } from '../../context/LanguageContext';
import { nextWidth } from '../../data/workspaceService';
import WidgetFrame from './WidgetFrame';

// How close to the viewport edge a touch drag starts scrolling the page.
const AUTO_SCROLL_EDGE = 90;
const AUTO_SCROLL_STEP = 16;

const IDLE = { code: null, source: null, overCode: null, side: 'before' };

/** Moves `fromCode` next to `toCode` and returns the new order of codes. */
const reorderCodes = (codes, fromCode, toCode, side) => {
  const without = codes.filter((code) => code !== fromCode);
  const index = without.indexOf(toCode);
  if (index < 0) return codes;
  without.splice(side === 'after' ? index + 1 : index, 0, fromCode);
  return without;
};

/**
 * The board itself: a twelve column grid where each card spans its own width,
 * reordered by dragging (mouse via the native HTML5 drag events, touch and pen
 * via pointer events) or by Ctrl/Cmd + the arrow keys.
 *
 * The grid never persists anything. It reports the new order upwards and the
 * dashboard decides how to store it, which is what makes an optimistic update
 * with a rollback possible.
 */
const WidgetGrid = ({ widgets, renderWidget, onReorder, onUpdate }) => {
  const { t, isRtl } = useLanguage();
  const reduceMotion = useReducedMotion();
  const hintId = useId();
  const gridRef = useRef(null);
  const armedRef = useRef(null);
  const dragRef = useRef(IDLE);
  const [drag, setDrag] = useState(IDLE);
  const [announcement, setAnnouncement] = useState('');

  // Mirrored for the drag listeners, which run outside React's render pass.
  useEffect(() => { dragRef.current = drag; }, [drag]);

  const codes = useMemo(() => widgets.map((widget) => widget.code), [widgets]);
  const titles = useMemo(
    () => widgets.reduce((all, widget) => ({ ...all, [widget.code]: widget.title }), {}),
    [widgets],
  );

  const announce = useCallback((code, order) => {
    const position = order.indexOf(code) + 1;
    if (position < 1) return;
    setAnnouncement(t('ws_moved', { name: titles[code] || code, position, total: order.length }));
  }, [t, titles]);

  // Which edge of the hovered card the dragged card would land on. A card that
  // fills the row is split top/bottom; anything narrower is split along the
  // inline axis, which flips automatically in Arabic.
  const sideFor = useCallback((clientX, clientY, element) => {
    const rect = element.getBoundingClientRect();
    const gridWidth = gridRef.current?.getBoundingClientRect().width || rect.width;
    if (rect.width > gridWidth * 0.9) {
      return clientY > rect.top + rect.height / 2 ? 'after' : 'before';
    }
    const past = clientX > rect.left + rect.width / 2;
    return (isRtl ? !past : past) ? 'after' : 'before';
  }, [isRtl]);

  const setOver = useCallback((overCode, side) => {
    setDrag((current) => (
      current.overCode === overCode && current.side === side ? current : { ...current, overCode, side }
    ));
  }, []);

  const commitDrop = useCallback(() => {
    const { code, overCode, side } = dragRef.current;
    setDrag(IDLE);
    armedRef.current = null;
    if (!code || !overCode || code === overCode) return;
    const order = reorderCodes(codes, code, overCode, side);
    announce(code, order);
    onReorder(order);
  }, [announce, codes, onReorder]);

  // A gesture that never became a drag must not leave the card armed.
  useEffect(() => {
    const clear = () => { armedRef.current = null; };
    window.addEventListener('pointerup', clear);
    window.addEventListener('dragend', clear);
    return () => {
      window.removeEventListener('pointerup', clear);
      window.removeEventListener('dragend', clear);
    };
  }, []);

  // Touch and pen: HTML5 drag events never fire, so the pointer stream drives
  // the same drop logic.
  useEffect(() => {
    if (drag.source !== 'pointer' || !drag.code) return undefined;

    const move = (event) => {
      event.preventDefault();
      if (event.clientY < AUTO_SCROLL_EDGE) window.scrollBy(0, -AUTO_SCROLL_STEP);
      else if (event.clientY > window.innerHeight - AUTO_SCROLL_EDGE) window.scrollBy(0, AUTO_SCROLL_STEP);

      const element = document.elementFromPoint(event.clientX, event.clientY)?.closest?.('[data-widget-code]');
      if (!element || !gridRef.current?.contains(element)) return;
      const code = element.getAttribute('data-widget-code');
      if (!code || code === drag.code) return;
      setOver(code, sideFor(event.clientX, event.clientY, element));
    };

    const finish = () => commitDrop();
    const cancel = () => { setDrag(IDLE); armedRef.current = null; };

    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', cancel);
    document.body.classList.add('ws-dragging');

    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', cancel);
      document.body.classList.remove('ws-dragging');
    };
  }, [commitDrop, drag.code, drag.source, setOver, sideFor]);

  const moveBy = useCallback((widget, direction) => {
    const index = codes.indexOf(widget.code);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= codes.length) return;
    const order = [...codes];
    order.splice(index, 1);
    order.splice(target, 0, widget.code);
    announce(widget.code, order);
    onReorder(order);
  }, [announce, codes, onReorder]);

  const handleKeyDown = useCallback((event, widget) => {
    if (!event.ctrlKey && !event.metaKey) return;
    const backwards = isRtl ? 'ArrowRight' : 'ArrowLeft';
    const forwards = isRtl ? 'ArrowLeft' : 'ArrowRight';
    const direction = (event.key === 'ArrowUp' || event.key === backwards) ? -1
      : (event.key === 'ArrowDown' || event.key === forwards) ? 1
        : 0;
    if (!direction) return;
    event.preventDefault();
    moveBy(widget, direction);
  }, [isRtl, moveBy]);

  const dragHandleProps = useCallback((widget) => ({
    onPointerDown: (event) => {
      armedRef.current = widget.code;
      // Mouse keeps the native drag & drop pipeline (drag image, drop effects).
      if (event.pointerType === 'mouse') return;
      event.preventDefault();
      setDrag({ code: widget.code, source: 'pointer', overCode: null, side: 'before' });
    },
    onKeyDown: (event) => handleKeyDown(event, widget),
  }), [handleKeyDown]);

  return (
    <>
      <p id={hintId} className="sr-only">{t('ws_drag_hint')}</p>

      <div className="ws-board" ref={gridRef} role="list" aria-label={t('ws_board_label')}>
        {widgets.map((widget) => (
          <motion.div
            key={widget.code}
            role="listitem"
            className="ws-cell"
            layout={!reduceMotion}
            transition={{ type: 'spring', stiffness: 420, damping: 36, mass: 0.7 }}
            data-widget-code={widget.code}
            data-width={widget.width}
            data-drop={drag.code && drag.overCode === widget.code ? drag.side : undefined}
            draggable
            onDragStart={(event) => {
              if (armedRef.current !== widget.code) { event.preventDefault(); return; }
              event.dataTransfer.effectAllowed = 'move';
              try { event.dataTransfer.setData('text/plain', widget.code); } catch { /* Safari refuses custom types while dragging */ }
              setDrag({ code: widget.code, source: 'mouse', overCode: null, side: 'before' });
            }}
            onDragOver={(event) => {
              const active = dragRef.current;
              if (active.source !== 'mouse' || !active.code || active.code === widget.code) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = 'move';
              setOver(widget.code, sideFor(event.clientX, event.clientY, event.currentTarget));
            }}
            onDragLeave={(event) => {
              if (event.currentTarget.contains(event.relatedTarget)) return;
              if (dragRef.current.overCode === widget.code) setOver(null, 'before');
            }}
            onDrop={(event) => { event.preventDefault(); commitDrop(); }}
            onDragEnd={() => { armedRef.current = null; setDrag(IDLE); }}
          >
            <WidgetFrame
              widget={widget}
              hintId={hintId}
              isDragging={drag.code === widget.code}
              dragHandleProps={dragHandleProps(widget)}
              onToggleCollapse={() => onUpdate(widget.code, { is_collapsed: !widget.is_collapsed })}
              onTogglePin={() => onUpdate(widget.code, { is_pinned: !widget.is_pinned })}
              onCycleWidth={() => onUpdate(widget.code, { width: nextWidth(widget.width) })}
              onHide={() => onUpdate(widget.code, { is_visible: false })}
            >
              {renderWidget(widget)}
            </WidgetFrame>
          </motion.div>
        ))}
      </div>

      <p className="sr-only" role="status" aria-live="polite">{announcement}</p>
    </>
  );
};

export default WidgetGrid;

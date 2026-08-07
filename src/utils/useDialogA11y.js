import { useEffect, useRef } from 'react';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

/**
 * The minimum modal-dialog accessibility contract this app's dialogs share:
 * focus the close control the moment the dialog opens, trap Tab/Shift+Tab
 * inside the dialog while it is open, restore focus to whichever element
 * opened the dialog once it closes, and let Escape close it. Pair with
 * role="dialog" aria-modal="true" on the dialog element itself and
 * aria-label={t('action_close')} on the button the returned ref is
 * attached to — matching the pattern already established (and reviewed) in
 * src/components/verification/AttestationsScreen.jsx.
 */
export const useDialogA11y = (onClose) => {
  const closeRef = useRef(null);

  // Capture the triggering element once on true mount and restore focus to
  // it once on true unmount. Kept in its own effect with an empty deps
  // array — deliberately independent of `onClose` identity — so an onClose
  // prop that is re-created on every parent render (e.g. an inline arrow
  // function while the user edits form state) can't re-fire this and eject
  // focus out of the dialog mid-edit.
  useEffect(() => {
    const triggerEl = document.activeElement;
    return () => {
      if (triggerEl && typeof triggerEl.focus === 'function' && document.contains(triggerEl)) {
        try { triggerEl.focus(); } catch { /* trigger element refused focus; ignore */ }
      }
    };
  }, []);

  useEffect(() => {
    closeRef.current?.focus();
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const dialog = closeRef.current?.closest('[role="dialog"]');
      if (!dialog) return;
      const focusable = Array.from(dialog.querySelectorAll(FOCUSABLE_SELECTOR));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return closeRef;
};

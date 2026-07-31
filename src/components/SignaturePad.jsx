import { useEffect, useRef } from 'react';
import { Eraser, PenLine } from 'lucide-react';
import { useLanguage } from '../context/LanguageContext';

const SignaturePad = ({ onSave, busy }) => {
  const canvasRef = useRef(null);
  const drawingRef = useRef(false);
  const { t } = useLanguage();

  useEffect(() => {
    const canvas = canvasRef.current;
    const ratio = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    canvas.width = width * ratio;
    canvas.height = height * ratio;
    const context = canvas.getContext('2d');
    context.scale(ratio, ratio);
    context.lineWidth = 2;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.strokeStyle = '#17231e';
  }, []);

  const point = (event) => {
    const rect = canvasRef.current.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const start = (event) => {
    event.preventDefault();
    drawingRef.current = true;
    const context = canvasRef.current.getContext('2d');
    const next = point(event);
    context.beginPath();
    context.moveTo(next.x, next.y);
    canvasRef.current.setPointerCapture(event.pointerId);
  };

  const draw = (event) => {
    if (!drawingRef.current) return;
    const context = canvasRef.current.getContext('2d');
    const next = point(event);
    context.lineTo(next.x, next.y);
    context.stroke();
  };

  const stop = () => {
    drawingRef.current = false;
  };

  const clear = () => {
    const canvas = canvasRef.current;
    const context = canvas.getContext('2d');
    context.clearRect(0, 0, canvas.width, canvas.height);
  };

  const save = () => {
    canvasRef.current.toBlob((blob) => {
      if (blob) onSave(new File([blob], 'signature.png', { type: 'image/png' }));
    }, 'image/png');
  };

  return (
    <div className="signature-pad">
      <canvas
        ref={canvasRef}
        onPointerDown={start}
        onPointerMove={draw}
        onPointerUp={stop}
        onPointerCancel={stop}
      />
      <div>
        <button type="button" className="secondary-button" onClick={clear}><Eraser /> {t('clear_signature')}</button>
        <button type="button" className="primary-button" disabled={busy} onClick={save}><PenLine /> {t('save_signature')}</button>
      </div>
    </div>
  );
};

export default SignaturePad;

// Email signature builder — reads the same card data (never a second source
// of truth), builds a real HTML signature (the spec's own recommendation
// over an image: responsive, clickable, light — see FourthUpdate.md), plus
// a genuine canvas-rendered "copy as image" fallback for mail clients that
// mangle pasted HTML. The QR embedded in the signature is a data: URI
// captured from Platform Core's own EntityQrCode — never a second QR
// implementation and never a third-party QR web service (which would leak
// the card link to an outside host on every signature render).

import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Copy, Download, Image as ImageIcon } from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { cardUrl } from '../../lib/routing';
import { identityErrorKey, loadMyCard } from '../../data/digitalIdentityService';
import { pickFromMap, pickLocalized } from '../../utils/localize';
import EntityQrCode from '../platform/EntityQrCode';
import './identity.css';

const SIZES = { Compact: { avatar: 56, font: 12 }, Regular: { avatar: 72, font: 13 } };

const svgToDataUri = (svgElement) => {
  if (!svgElement) return '';
  const markup = new XMLSerializer().serializeToString(svgElement);
  return `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(markup)))}`;
};

// Profile/company fields are HR-managed, not self-authored — they must be
// treated as untrusted before landing in this HTML string, which is both
// rendered via dangerouslySetInnerHTML and handed to the user as real HTML
// to paste into an outgoing email signature (closing audit Blocker).
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
));

const buildSignatureHtml = (card, lang, color, size, includeQr, qrDataUri) => {
  const p = card.profile || {};
  const link = cardUrl(card.public_code);
  const name = escapeHtml(pickLocalized({ name_ar: p.name_ar, name_en: p.name_en }, 'name', lang, p.full_name) || p.full_name);
  const title = escapeHtml(pickLocalized({ job_title_ar: p.job_title_ar, job_title_en: p.job_title_en }, 'job_title', lang, p.job_title) || p.job_title);
  const company = escapeHtml(pickFromMap(card.company?.names, lang));
  const mobile = escapeHtml(p.mobile);
  const email = escapeHtml(p.email);
  const avatarUrl = escapeHtml(p.avatar_url);
  // color comes from tenant_branding.primary_color — an admin-settable value
  // with no server-side format constraint, so it needs exactly the same
  // escaping as every other interpolated field here, not an exemption.
  const safeColor = escapeHtml(color);
  const dims = SIZES[size] || SIZES.Regular;
  const rows = [
    p.mobile && `<a href="tel:${mobile}" style="color:${safeColor};text-decoration:none;">${mobile}</a>`,
    p.email && `<a href="mailto:${email}" style="color:${safeColor};text-decoration:none;">${email}</a>`,
    `<a href="${link}" style="color:${safeColor};text-decoration:none;">${link.replace(/^https?:\/\//, '')}</a>`,
  ].filter(Boolean).join(' &middot; ');

  return `<table cellpadding="0" cellspacing="0" style="font-family:Arial,Helvetica,sans-serif;font-size:${dims.font}px;color:#333333;">
  <tr>
    ${p.avatar_url ? `<td style="padding-right:14px;"><a href="${link}"><img src="${avatarUrl}" width="${dims.avatar}" height="${dims.avatar}" style="border-radius:50%;display:block;" alt="${name}" /></a></td>` : ''}
    <td style="border-left:2px solid ${safeColor};padding-left:14px;">
      <div style="font-weight:bold;font-size:${dims.font + 2}px;color:#111111;">${name}</div>
      ${title ? `<div style="color:#555555;">${title}${company ? ` &mdash; ${company}` : ''}</div>` : ''}
      <div style="margin-top:6px;">${rows}</div>
    </td>
    ${includeQr && qrDataUri ? `<td style="padding-inline-start:14px;"><a href="${link}"><img src="${qrDataUri}" width="${dims.avatar}" height="${dims.avatar}" alt="QR" /></a></td>` : ''}
  </tr>
</table>`;
};

const EmailSignatureScreen = () => {
  const { t, lang } = useLanguage();
  const [card, setCard] = useState(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState(null);
  const [color, setColor] = useState('#0f766e');
  const [size, setSize] = useState('Regular');
  const [includeQr, setIncludeQr] = useState(false);
  const [qrDataUri, setQrDataUri] = useState('');
  const [copied, setCopied] = useState('');
  const qrHostRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    loadMyCard().then(({ data, error }) => {
      if (cancelled) return;
      setLoading(false);
      if (error) { setNotice({ tone: 'error', text: t(identityErrorKey(error)) }); return; }
      setCard(data);
      setColor(data.company?.primary_color || '#0f766e');
    });
    return () => { cancelled = true; };
  }, [t]);

  // Captures EntityQrCode's own rendered SVG (hidden below) as a static data
  // URI once the card is loaded — the one and only QR renderer, just read
  // back as a string instead of left live in the DOM.
  useEffect(() => {
    if (!card) return;
    const svg = qrHostRef.current?.querySelector('svg');
    if (svg) setQrDataUri(svgToDataUri(svg));
  }, [card]);

  const html = useMemo(
    () => (card ? buildSignatureHtml(card, lang, color, size, includeQr, qrDataUri) : ''),
    [card, lang, color, size, includeQr, qrDataUri]
  );

  const flash = (label) => { setCopied(label); setTimeout(() => setCopied(''), 2200); };

  const copyHtml = async () => {
    try {
      const blob = new Blob([html], { type: 'text/html' });
      await navigator.clipboard.write([new ClipboardItem({ 'text/html': blob, 'text/plain': new Blob([html], { type: 'text/plain' }) })]);
      flash('html');
    } catch {
      try { await navigator.clipboard.writeText(html); flash('html'); } catch { /* clipboard unavailable */ }
    }
  };

  const downloadHtml = () => {
    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'email-signature.html';
    link.click();
    URL.revokeObjectURL(url);
  };

  const copyAsImage = async () => {
    if (!card) return;
    const width = 520;
    const height = 120;
    const canvas = document.createElement('canvas');
    canvas.width = width * 2;
    canvas.height = height * 2;
    const ctx = canvas.getContext('2d');
    ctx.scale(2, 2);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = color;
    ctx.fillRect(84, 16, 3, 88);

    const p = card.profile || {};
    const name = pickLocalized({ name_ar: p.name_ar, name_en: p.name_en }, 'name', lang, p.full_name) || p.full_name;
    const title = pickLocalized({ job_title_ar: p.job_title_ar, job_title_en: p.job_title_en }, 'job_title', lang, p.job_title) || p.job_title;

    const drawText = () => {
      ctx.fillStyle = '#111111';
      ctx.font = 'bold 16px Arial';
      ctx.fillText(name, 100, 34);
      ctx.fillStyle = '#555555';
      ctx.font = '13px Arial';
      if (title) ctx.fillText(title, 100, 54);
      ctx.font = '12px Arial';
      const contact = [p.mobile, p.email].filter(Boolean).join('   ·   ');
      ctx.fillText(contact, 100, 78);
      ctx.fillStyle = color;
      ctx.fillText(cardUrl(card.public_code).replace(/^https?:\/\//, ''), 100, 96);
    };

    if (p.avatar_url) {
      const img = new window.Image();
      img.crossOrigin = 'anonymous';
      await new Promise((resolve) => {
        img.onload = () => {
          ctx.save();
          ctx.beginPath();
          ctx.arc(48, 60, 32, 0, Math.PI * 2);
          ctx.clip();
          ctx.drawImage(img, 16, 28, 64, 64);
          ctx.restore();
          resolve();
        };
        img.onerror = resolve;
        img.src = p.avatar_url;
      });
    }
    drawText();

    canvas.toBlob(async (blob) => {
      if (!blob) return;
      try {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        flash('image');
      } catch {
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = 'email-signature.png';
        link.click();
        URL.revokeObjectURL(url);
      }
    });
  };

  if (loading || !card) {
    return <div className="page-loader inline-loader"><span /></div>;
  }

  return (
    <div className="vf-screen">
      <div className="vf-screen-head">
        <div>
          <span className="section-kicker">{t('module_identity')}</span>
          <h1>{t('di_sig_title')}</h1>
          <p>{t('di_sig_intro')}</p>
        </div>
      </div>

      {notice && <div className="inline-message error" role="status" aria-live="polite">{notice.text}</div>}

      {/* Hidden — exists only so its rendered SVG can be captured as a data URI above. */}
      <div ref={qrHostRef} style={{ position: 'absolute', inset: 0, width: 1, height: 1, overflow: 'hidden', opacity: 0 }} aria-hidden="true">
        <EntityQrCode value={cardUrl(card.public_code)} size={144} />
      </div>

      <div className="di-settings-grid">
        <section className="vf-panel">
          <label className="field-label" htmlFor="di-sig-color">
            {t('di_sig_color')}
            <input id="di-sig-color" type="color" className="form-input" value={color} onChange={(event) => setColor(event.target.value)} />
          </label>

          <label className="field-label">{t('di_sig_size')}</label>
          <div className="di-swatch-row">
            {Object.keys(SIZES).map((option) => (
              <button key={option} type="button" aria-pressed={size === option} className={`di-swatch ${size === option ? 'active' : ''}`} onClick={() => setSize(option)}>
                {t(option === 'Compact' ? 'di_sig_size_compact' : 'di_sig_size_regular')}
              </button>
            ))}
          </div>

          <label className="field-label field-checkbox">
            <input type="checkbox" checked={includeQr} onChange={(event) => setIncludeQr(event.target.checked)} />
            {t('di_sig_include_qr')}
          </label>

          <div className="di-share-actions">
            <button type="button" className="secondary-button" onClick={downloadHtml}><Download aria-hidden="true" /> {t('di_sig_download_html')}</button>
            <button type="button" className="secondary-button" onClick={copyHtml}>
              {copied === 'html' ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />} {t('di_sig_copy_html')}
            </button>
            <button type="button" className="secondary-button" onClick={copyAsImage}>
              {copied === 'image' ? <Check aria-hidden="true" /> : <ImageIcon aria-hidden="true" />} {t('di_sig_copy_image')}
            </button>
          </div>

          <p className="field-note">{t('di_sig_guide_intro')}</p>
          <ul>
            <li><b>{t('di_sig_guide_gmail')}</b> — {t('di_sig_guide_gmail_steps')}</li>
            <li><b>{t('di_sig_guide_outlook')}</b> — {t('di_sig_guide_outlook_steps')}</li>
            <li><b>{t('di_sig_guide_apple')}</b> — {t('di_sig_guide_apple_steps')}</li>
          </ul>
        </section>

        <section className="vf-panel">
          <h2>{t('di_sig_preview')}</h2>
          <div className="di-signature-preview" dangerouslySetInnerHTML={{ __html: html }} />
        </section>
      </div>
    </div>
  );
};

export default EmailSignatureScreen;

import { QRCodeSVG } from 'qrcode.react';
import logo from '../assets/logo.png';

const verifyUrl = (verifyCode) => (
  `${window.location.origin}${import.meta.env.BASE_URL || '/'}#/verify?code=${verifyCode}`
);

export const FormDocumentHeader = ({ moduleName, title, code, reference, verifyCode }) => (
  <header className="evaluation-header form-document-header">
    <img src={logo} alt="Shalfa" />
    <div>{moduleName && <span>{moduleName}</span>}<h1>{title}</h1></div>
    <div className="document-meta">
      <b>{code}</b>
      <small>{reference}</small>
      {verifyCode && <small className="verify-code" dir="ltr">{verifyCode}</small>}
      <QRCodeSVG value={verifyCode ? verifyUrl(verifyCode) : `ShalfaGate:${reference}`} size={54} />
    </div>
  </header>
);

export const FormDocumentFooter = ({ product = 'ShalfaGate', title, generatedLabel, generatedDate, printedByLabel, printedBy, pageLabel }) => (
  <footer className="document-footer print-only">
    <span>{product} · {title}</span>
    <span>{generatedLabel}: {generatedDate}</span>
    <span>{printedByLabel}: {printedBy || '—'}</span>
    <span>{pageLabel} <b className="page-number" /></span>
  </footer>
);

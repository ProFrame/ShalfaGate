import { QRCodeSVG } from 'qrcode.react';

/**
 * Platform Core's one QR renderer (bbnovix_contract.md §12). Any module that
 * needs a QR code for an entity number or a URL uses this — never wraps
 * qrcode.react itself a second time. Verification's own seal (VerifiedSeal.jsx)
 * is built on top of this, not a separate implementation.
 *
 * @param {{ value: string, size?: number, level?: 'L'|'M'|'Q'|'H', bgColor?: string, fgColor?: string, title?: string, className?: string }} props
 */
const EntityQrCode = ({
  value,
  size = 96,
  level = 'M',
  bgColor = '#ffffff',
  fgColor = '#0b1b2b',
  title,
  className = '',
}) => {
  if (!value) return null;
  return (
    <QRCodeSVG
      className={className}
      value={value}
      size={size}
      level={level}
      bgColor={bgColor}
      fgColor={fgColor}
      marginSize={2}
      title={title}
      role="img"
    />
  );
};

export default EntityQrCode;

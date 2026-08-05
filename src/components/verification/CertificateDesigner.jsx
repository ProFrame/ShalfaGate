// The certificate template designer.
//
// A template is a background image plus absolutely positioned fields. The
// canvas below shows the real background at whatever scale fits the screen,
// while every coordinate is stored in true page pixels — so what the designer
// drags is exactly what the printer prints.
//
// `CertificateCanvas` is exported because the issuing screen replays the same
// layout for previewing and printing an issued certificate: one renderer, one
// truth about where a field sits.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, AlignCenter, AlignLeft, AlignRight, Eye, Image as ImageIcon,
  LayoutTemplate, Loader2, Move, Plus, Save, Trash2, Upload, X, ZoomIn, ZoomOut,
} from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { useTenant } from '../../context/TenantContext';
import { formatDate, formatNumber, pickLocalized } from '../../utils/localize';
import {
  FIELD_ALIGNMENTS, FIELD_ANCHORS, FIELD_TYPES, FONT_WEIGHTS, PAGE_PRESETS, SEAL_STYLES,
  deleteTemplate, isValidFieldKey, loadTemplateFields, loadTemplates, saveTemplate,
  saveTemplateFields, uploadVerificationFile, verificationErrorKey,
} from '../../data/verificationService';
import { VerificationQr } from './VerifiedSeal';

const FONT_CHOICES = ['Segoe UI', 'Tahoma', 'Georgia', 'Times New Roman', 'Amiri', 'Cairo', 'Tajawal'];

const TYPE_LABEL_KEYS = {
  Text: 'vf_type_text',
  Date: 'vf_type_date',
  Number: 'vf_type_number',
  Image: 'vf_type_image',
  QR: 'vf_type_qr',
  Code: 'vf_type_code',
};

const ALIGN_LABEL_KEYS = { Start: 'vf_align_start', Center: 'vf_align_center', End: 'vf_align_end' };
const ANCHOR_LABEL_KEYS = { TopStart: 'vf_anchor_topstart', TopCenter: 'vf_anchor_topcenter', TopEnd: 'vf_anchor_topend' };
const WEIGHT_LABEL_KEYS = { 400: 'vf_weight_regular', 600: 'vf_weight_medium', 800: 'vf_weight_bold' };
const ALIGN_ICONS = { Start: AlignLeft, Center: AlignCenter, End: AlignRight };

const round = (value) => Math.round(Number(value) * 100) / 100;
const clamp = (value, min, max) => Math.min(Math.max(value, min), Math.max(min, max));

const emptyTemplate = () => ({
  id: null,
  code: '',
  name_ar: '',
  name_en: '',
  description_ar: '',
  description_en: '',
  background_url: '',
  page_width_px: 1123,
  page_height_px: 794,
  orientation: 'Landscape',
  seal_style: 'Gold',
  display_order: 0,
  is_active: true,
});

const newField = (index) => ({
  id: null,
  localId: `new-${Date.now()}-${index}`,
  field_key: `field_${index + 1}`,
  label_ar: '',
  label_en: '',
  field_type: 'Text',
  pos_x_px: 80,
  pos_y_px: 80 + index * 46,
  width_px: 320,
  height_px: 44,
  font_family: '',
  font_size_px: 24,
  font_weight: '600',
  color: '#111827',
  align: 'Start',
  anchor: 'TopStart',
  default_value: '',
  is_required: false,
  display_order: (index + 1) * 10,
});

const keyOf = (field) => field.id || field.localId;

// ---------------------------------------------------------------------------
// The renderer — shared by the designer, the preview and the print sheet
// ---------------------------------------------------------------------------

const alignToFlex = (align) => (align === 'Center' ? 'center' : align === 'End' ? 'flex-end' : 'flex-start');

const fieldBoxStyle = (field, isRtl) => {
  const style = {
    top: `${Number(field.pos_y_px) || 0}px`,
    width: field.width_px ? `${field.width_px}px` : 'auto',
    height: field.height_px ? `${field.height_px}px` : 'auto',
    fontSize: `${field.font_size_px || 16}px`,
    fontWeight: field.font_weight || '400',
    color: field.color || '#111827',
    fontFamily: field.font_family || undefined,
    textAlign: field.align === 'Center' ? 'center' : field.align === 'End' ? 'end' : 'start',
    justifyContent: alignToFlex(field.align),
  };

  const x = Number(field.pos_x_px) || 0;
  if (field.anchor === 'TopEnd') {
    style.insetInlineEnd = `${x}px`;
  } else if (field.anchor === 'TopCenter') {
    style.insetInlineStart = `calc(50% + ${x}px)`;
    style.transform = `translateX(${isRtl ? '' : '-'}50%)`;
  } else {
    style.insetInlineStart = `${x}px`;
  }

  return style;
};

const FieldContent = ({ field, value, code, locale, lang, placeholder }) => {
  const raw = value ?? field.default_value ?? '';

  if (field.field_type === 'QR') {
    const size = Math.max(Math.min(Number(field.width_px) || 110, Number(field.height_px) || 110), 40);
    return code
      ? <VerificationQr code={code} size={size} />
      : <span className="vf-field-placeholder">{placeholder}</span>;
  }

  if (field.field_type === 'Code') {
    return <span className="verify-code" dir="ltr">{code || placeholder}</span>;
  }

  if (field.field_type === 'Image') {
    return raw
      ? <img src={raw} alt={pickLocalized(field, 'label', lang, field.field_key)} />
      : <span className="vf-field-placeholder"><ImageIcon aria-hidden="true" /> {placeholder}</span>;
  }

  if (!String(raw).trim()) return <span className="vf-field-placeholder">{placeholder}</span>;

  if (field.field_type === 'Date') return <span>{formatDate(raw, locale) || String(raw)}</span>;
  if (field.field_type === 'Number') return <span>{formatNumber(raw, locale) || String(raw)}</span>;
  return <span>{String(raw)}</span>;
};

/**
 * @param {object} props
 * @param {object} props.template        page size, orientation, background
 * @param {Array}  props.fields          the stored layout
 * @param {object} [props.values]        field_key → value
 * @param {string} [props.code]          document code, for QR and Code fields
 * @param {number} [props.scale]         screen scale; coordinates stay true px
 * @param {boolean} [props.interactive]  render fields as draggable buttons
 */
export const CertificateCanvas = ({
  template,
  fields = [],
  values = {},
  code = '',
  scale = 1,
  interactive = false,
  selectedKey = null,
  showGrid = false,
  gridSize = 20,
  pageRef = null,
  onFieldPointerDown,
  onFieldKeyDown,
  onSelectField,
  className = '',
}) => {
  const { t, lang, locale, isRtl } = useLanguage();
  const width = Number(template?.page_width_px) || 1123;
  const height = Number(template?.page_height_px) || 794;

  return (
    <div
      className={`vf-canvas ${className}`}
      style={{ width: `${width * scale}px`, height: `${height * scale}px` }}
    >
      <div
        ref={pageRef}
        className="vf-canvas-page"
        style={{
          width: `${width}px`,
          height: `${height}px`,
          transform: `scale(${scale})`,
          transformOrigin: isRtl ? 'top right' : 'top left',
        }}
      >
        {template?.background_url
          ? <img className="vf-canvas-background" src={template.background_url} alt="" />
          : <span className="vf-canvas-empty" aria-hidden="true"><LayoutTemplate /></span>}

        {showGrid && (
          <span
            className="vf-canvas-grid"
            aria-hidden="true"
            style={{ backgroundSize: `${gridSize}px ${gridSize}px` }}
          />
        )}

        {fields.map((field) => {
          const label = pickLocalized(field, 'label', lang, field.field_key);
          const content = (
            <FieldContent
              field={field}
              value={values[field.field_key]}
              code={code}
              locale={locale}
              lang={lang}
              placeholder={label}
            />
          );

          if (!interactive) {
            return (
              <div key={keyOf(field)} className="vf-canvas-field" style={fieldBoxStyle(field, isRtl)}>
                {content}
              </div>
            );
          }

          return (
            <button
              key={keyOf(field)}
              type="button"
              className={`vf-canvas-field interactive ${selectedKey === keyOf(field) ? 'selected' : ''}`}
              style={fieldBoxStyle(field, isRtl)}
              aria-label={t('vf_move_field', { field: label })}
              onPointerDown={(event) => onFieldPointerDown?.(field, event)}
              onKeyDown={(event) => onFieldKeyDown?.(field, event)}
              onFocus={() => onSelectField?.(keyOf(field))}
            >
              {content}
            </button>
          );
        })}
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Side panels
// ---------------------------------------------------------------------------

const TemplateList = ({ templates, selectedId, onSelect, onCreate }) => {
  const { t, lang } = useLanguage();

  return (
    <section className="vf-panel vf-template-list">
      <div className="vf-panel-head">
        <h2>{t('vf_tpl_list')}</h2>
        <button type="button" className="secondary-button" onClick={onCreate}>
          <Plus aria-hidden="true" /> {t('vf_tpl_new')}
        </button>
      </div>

      {templates.length === 0 ? (
        <div className="empty-table compact">
          <LayoutTemplate aria-hidden="true" />
          <b>{t('vf_tpl_no_templates')}</b>
          <span>{t('vf_tpl_no_templates_hint')}</span>
        </div>
      ) : (
        <ul className="vf-template-items">
          {templates.map((template) => (
            <li key={template.id}>
              <button
                type="button"
                className={selectedId === template.id ? 'active' : ''}
                onClick={() => onSelect(template.id)}
                aria-current={selectedId === template.id ? 'true' : undefined}
              >
                <span className="vf-template-thumb" aria-hidden="true">
                  {template.background_url
                    ? <img src={template.background_url} alt="" />
                    : <LayoutTemplate />}
                </span>
                <span className="vf-template-meta">
                  <b>{pickLocalized(template, 'name', lang, template.code)}</b>
                  <small dir="ltr">{template.code}</small>
                  {!template.is_active && <small>{t('label_disabled')}</small>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};

const TemplateSettings = ({ template, onChange, onUploadBackground, onDelete, uploading }) => {
  const { t } = useLanguage();
  const fileRef = useRef(null);

  const presetCode = PAGE_PRESETS.find((preset) => {
    const [w, h] = template.orientation === 'Portrait'
      ? [preset.height, preset.width]
      : [preset.width, preset.height];
    return w === Number(template.page_width_px) && h === Number(template.page_height_px);
  })?.code || 'Custom';

  const applyPreset = (code, orientation = template.orientation) => {
    if (code === 'Custom') {
      onChange({ orientation });
      return;
    }
    const preset = PAGE_PRESETS.find((item) => item.code === code);
    if (!preset) return;
    const [width, height] = orientation === 'Portrait'
      ? [preset.height, preset.width]
      : [preset.width, preset.height];
    onChange({ orientation, page_width_px: width, page_height_px: height });
  };

  const changeOrientation = (orientation) => {
    if (presetCode === 'Custom') {
      onChange({
        orientation,
        page_width_px: template.page_height_px,
        page_height_px: template.page_width_px,
      });
      return;
    }
    applyPreset(presetCode, orientation);
  };

  return (
    <section className="vf-panel">
      <div className="vf-panel-head"><h2>{t('vf_designer_title')}</h2></div>

      <div className="vf-form-grid">
        <label className="field-label" htmlFor="vf-tpl-name-1">
          {t('vf_tpl_name_1')}
          <input
            id="vf-tpl-name-1"
            className="form-input"
            value={template.name_ar || ''}
            onChange={(event) => onChange({ name_ar: event.target.value })}
            placeholder={t('vf_tpl_name_1')}
          />
        </label>

        <label className="field-label" htmlFor="vf-tpl-name-2">
          {t('vf_tpl_name_2')}
          <input
            id="vf-tpl-name-2"
            className="form-input"
            value={template.name_en || ''}
            onChange={(event) => onChange({ name_en: event.target.value })}
            placeholder={t('vf_tpl_name_2')}
          />
        </label>

        <label className="field-label" htmlFor="vf-tpl-code">
          {t('vf_tpl_code')}
          <input
            id="vf-tpl-code"
            className="form-input"
            dir="ltr"
            value={template.code || ''}
            onChange={(event) => onChange({ code: event.target.value.toUpperCase() })}
            placeholder={t('vf_tpl_code')}
          />
        </label>

        <label className="field-label" htmlFor="vf-tpl-seal">
          {t('vf_field_seal')}
          <select
            id="vf-tpl-seal"
            className="form-input"
            value={template.seal_style}
            onChange={(event) => onChange({ seal_style: event.target.value })}
          >
            {SEAL_STYLES.map((style) => (
              <option key={style} value={style}>{t(style === 'Gold' ? 'vf_seal_gold' : 'vf_seal_blue')}</option>
            ))}
          </select>
        </label>

        <label className="field-label" htmlFor="vf-tpl-orientation">
          {t('vf_page_orientation')}
          <select
            id="vf-tpl-orientation"
            className="form-input"
            value={template.orientation}
            onChange={(event) => changeOrientation(event.target.value)}
          >
            <option value="Landscape">{t('vf_orientation_landscape')}</option>
            <option value="Portrait">{t('vf_orientation_portrait')}</option>
          </select>
        </label>

        <label className="field-label" htmlFor="vf-tpl-preset">
          {t('vf_page_preset')}
          <select
            id="vf-tpl-preset"
            className="form-input"
            value={presetCode}
            onChange={(event) => applyPreset(event.target.value)}
          >
            {PAGE_PRESETS.map((preset) => (
              <option key={preset.code} value={preset.code}>{t(`vf_page_preset_${preset.code.toLowerCase()}`)}</option>
            ))}
            <option value="Custom">{t('vf_page_preset_custom')}</option>
          </select>
        </label>

        <label className="field-label" htmlFor="vf-tpl-width">
          {t('vf_page_width')}
          <input
            id="vf-tpl-width"
            className="form-input"
            type="number"
            min="120"
            value={template.page_width_px}
            onChange={(event) => onChange({ page_width_px: Number(event.target.value) })}
          />
        </label>

        <label className="field-label" htmlFor="vf-tpl-height">
          {t('vf_page_height')}
          <input
            id="vf-tpl-height"
            className="form-input"
            type="number"
            min="120"
            value={template.page_height_px}
            onChange={(event) => onChange({ page_height_px: Number(event.target.value) })}
          />
        </label>
      </div>

      <div className="vf-background-row">
        <div>
          <span className="field-label">{t('vf_tpl_background')}</span>
          <p className="field-note">{t('vf_tpl_background_hint')}</p>
        </div>
        <div className="vf-inline-actions">
          <button type="button" className="secondary-button" onClick={() => fileRef.current?.click()} disabled={uploading}>
            {uploading ? <Loader2 className="vf-spin" aria-hidden="true" /> : <Upload aria-hidden="true" />}
            {uploading ? t('vf_file_uploading') : t('vf_tpl_upload_background')}
          </button>
          {template.background_url && (
            <button type="button" className="secondary-button danger" onClick={() => onChange({ background_url: '' })}>
              <X aria-hidden="true" /> {t('vf_tpl_remove_background')}
            </button>
          )}
          <input
            ref={fileRef}
            hidden
            type="file"
            accept="image/png,image/jpeg,image/webp"
            aria-label={t('vf_tpl_upload_background')}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) onUploadBackground(file);
            }}
          />
        </div>
      </div>

      <label className="content-publish-check">
        <input
          type="checkbox"
          checked={template.is_active !== false}
          onChange={(event) => onChange({ is_active: event.target.checked })}
        />
        {t('vf_tpl_active')}
      </label>

      {template.id && (
        <button type="button" className="text-button vf-danger-text" onClick={onDelete}>
          <Trash2 aria-hidden="true" /> {t('vf_tpl_delete')}
        </button>
      )}
    </section>
  );
};

const FieldInspector = ({ field, onChange, onDelete }) => {
  const { t } = useLanguage();

  if (!field) {
    return (
      <section className="vf-panel">
        <div className="vf-panel-head"><h2>{t('vf_selected_field')}</h2></div>
        <p className="field-note">{t('vf_select_field_hint')}</p>
      </section>
    );
  }

  const keyInvalid = !isValidFieldKey(field.field_key);

  return (
    <section className="vf-panel">
      <div className="vf-panel-head">
        <h2>{t('vf_selected_field')}</h2>
        <button type="button" className="icon-button" onClick={onDelete} aria-label={t('vf_delete_field')} title={t('vf_delete_field')}>
          <Trash2 aria-hidden="true" />
        </button>
      </div>

      <div className="vf-form-grid">
        <label className="field-label vf-span-2" htmlFor="vf-field-key">
          {t('vf_field_key')}
          <input
            id="vf-field-key"
            className="form-input"
            dir="ltr"
            value={field.field_key}
            aria-invalid={keyInvalid || undefined}
            onChange={(event) => onChange({ field_key: event.target.value })}
          />
          <p className="field-note">{keyInvalid ? t('vf_err_field_key_invalid') : t('vf_field_key_hint')}</p>
        </label>

        <label className="field-label" htmlFor="vf-field-label-1">
          {t('vf_field_label_1')}
          <input
            id="vf-field-label-1"
            className="form-input"
            value={field.label_ar || ''}
            onChange={(event) => onChange({ label_ar: event.target.value })}
            placeholder={t('vf_field_label_1')}
          />
        </label>

        <label className="field-label" htmlFor="vf-field-label-2">
          {t('vf_field_label_2')}
          <input
            id="vf-field-label-2"
            className="form-input"
            value={field.label_en || ''}
            onChange={(event) => onChange({ label_en: event.target.value })}
            placeholder={t('vf_field_label_2')}
          />
        </label>

        <label className="field-label" htmlFor="vf-field-type">
          {t('vf_field_type')}
          <select
            id="vf-field-type"
            className="form-input"
            value={field.field_type}
            onChange={(event) => onChange({ field_type: event.target.value })}
          >
            {FIELD_TYPES.map((type) => <option key={type} value={type}>{t(TYPE_LABEL_KEYS[type])}</option>)}
          </select>
        </label>

        <label className="field-label" htmlFor="vf-field-anchor">
          {t('vf_anchor')}
          <select
            id="vf-field-anchor"
            className="form-input"
            value={field.anchor}
            onChange={(event) => onChange({ anchor: event.target.value })}
          >
            {FIELD_ANCHORS.map((anchor) => <option key={anchor} value={anchor}>{t(ANCHOR_LABEL_KEYS[anchor])}</option>)}
          </select>
        </label>

        <label className="field-label" htmlFor="vf-field-x">
          {t('vf_pos_x')}
          <input id="vf-field-x" className="form-input" type="number" value={field.pos_x_px}
            onChange={(event) => onChange({ pos_x_px: Number(event.target.value) })} />
        </label>

        <label className="field-label" htmlFor="vf-field-y">
          {t('vf_pos_y')}
          <input id="vf-field-y" className="form-input" type="number" value={field.pos_y_px}
            onChange={(event) => onChange({ pos_y_px: Number(event.target.value) })} />
        </label>

        <label className="field-label" htmlFor="vf-field-w">
          {t('vf_width')}
          <input id="vf-field-w" className="form-input" type="number" min="0" value={field.width_px ?? ''}
            onChange={(event) => onChange({ width_px: event.target.value === '' ? null : Number(event.target.value) })} />
        </label>

        <label className="field-label" htmlFor="vf-field-h">
          {t('vf_height')}
          <input id="vf-field-h" className="form-input" type="number" min="0" value={field.height_px ?? ''}
            onChange={(event) => onChange({ height_px: event.target.value === '' ? null : Number(event.target.value) })} />
        </label>

        <label className="field-label" htmlFor="vf-field-font">
          {t('vf_font_family')}
          <select
            id="vf-field-font"
            className="form-input"
            value={field.font_family || ''}
            onChange={(event) => onChange({ font_family: event.target.value })}
          >
            <option value="">{t('vf_font_default')}</option>
            {FONT_CHOICES.map((font) => <option key={font} value={font}>{font}</option>)}
          </select>
        </label>

        <label className="field-label" htmlFor="vf-field-size">
          {t('vf_font_size')}
          <input id="vf-field-size" className="form-input" type="number" min="4" value={field.font_size_px}
            onChange={(event) => onChange({ font_size_px: Number(event.target.value) })} />
        </label>

        <label className="field-label" htmlFor="vf-field-weight">
          {t('vf_font_weight')}
          <select
            id="vf-field-weight"
            className="form-input"
            value={field.font_weight}
            onChange={(event) => onChange({ font_weight: event.target.value })}
          >
            {FONT_WEIGHTS.map((weight) => <option key={weight} value={weight}>{t(WEIGHT_LABEL_KEYS[weight])}</option>)}
          </select>
        </label>

        <label className="field-label" htmlFor="vf-field-color">
          {t('vf_color')}
          <span className="vf-color-row">
            <input id="vf-field-color" type="color" value={field.color || '#111827'}
              onChange={(event) => onChange({ color: event.target.value })} />
            <input className="form-input" dir="ltr" value={field.color || ''}
              aria-label={t('vf_color')}
              onChange={(event) => onChange({ color: event.target.value })} />
          </span>
        </label>

        <div className="field-label vf-span-2">
          <span>{t('vf_align')}</span>
          <div className="segmented">
            {FIELD_ALIGNMENTS.map((align) => {
              const Icon = ALIGN_ICONS[align];
              return (
                <button
                  key={align}
                  type="button"
                  className={field.align === align ? 'active' : ''}
                  onClick={() => onChange({ align })}
                  aria-pressed={field.align === align}
                >
                  <Icon aria-hidden="true" size={14} /> {t(ALIGN_LABEL_KEYS[align])}
                </button>
              );
            })}
          </div>
        </div>

        <label className="field-label vf-span-2" htmlFor="vf-field-default">
          {t('vf_default_value')}
          <input
            id="vf-field-default"
            className="form-input"
            value={field.default_value || ''}
            onChange={(event) => onChange({ default_value: event.target.value })}
            placeholder={t('vf_default_value')}
          />
        </label>
      </div>

      <label className="content-publish-check">
        <input
          type="checkbox"
          checked={Boolean(field.is_required)}
          onChange={(event) => onChange({ is_required: event.target.checked })}
        />
        {t('vf_required_field')}
      </label>
    </section>
  );
};

// ---------------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------------

const CertificateDesigner = () => {
  const { t, lang, isRtl } = useLanguage();
  const { tenant, slug } = useTenant();

  const [templates, setTemplates] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [template, setTemplate] = useState(emptyTemplate);
  const [fields, setFields] = useState([]);
  const [selectedKey, setSelectedKey] = useState(null);

  const [zoom, setZoom] = useState(null);          // null = fit to the frame
  const [fitScale, setFitScale] = useState(0.5);
  const [snapGrid, setSnapGrid] = useState(true);
  const [snapCenter, setSnapCenter] = useState(true);
  const [preview, setPreview] = useState(false);

  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [notice, setNotice] = useState(null);      // { tone, text }
  const [confirmDelete, setConfirmDelete] = useState(false);

  const frameRef = useRef(null);
  const pageRef = useRef(null);
  const dragRef = useRef(null);

  const scale = zoom ?? fitScale;
  const sampleCode = `${String(slug || 'company').toUpperCase()}-000000000000`;

  // Opening a stored template replaces the draft. An unsaved new template is
  // expressed by selecting nothing, so it is never overwritten from the list.
  const openTemplate = useCallback((row) => {
    setSelectedId(row?.id || null);
    setTemplate(row ? { ...emptyTemplate(), ...row } : emptyTemplate());
    if (!row) setFields([]);
    setSelectedKey(null);
  }, []);

  const refreshTemplates = useCallback(async (preferId = null) => {
    const { data, error } = await loadTemplates();
    if (error) {
      setNotice({ tone: 'error', text: t(verificationErrorKey(error)) });
      return;
    }
    setTemplates(data);
    openTemplate(data.find((row) => row.id === (preferId || selectedId)) || data[0] || null);
  }, [selectedId, openTemplate, t]);

  useEffect(() => {
    let cancelled = false;
    loadTemplates().then(({ data, error }) => {
      if (cancelled) return;
      if (error) {
        setNotice({ tone: 'error', text: t(verificationErrorKey(error)) });
        return;
      }
      setTemplates(data);
      if (data[0]) openTemplate(data[0]);
    });
    return () => { cancelled = true; };
  }, [openTemplate, t]);

  useEffect(() => {
    if (!selectedId) return undefined;
    let cancelled = false;
    loadTemplateFields(selectedId).then(({ data, error }) => {
      if (cancelled) return;
      if (error) {
        setNotice({ tone: 'error', text: t(verificationErrorKey(error)) });
        return;
      }
      setFields(data.map((field) => ({ ...field })));
      setSelectedKey(null);
    });
    return () => { cancelled = true; };
  }, [selectedId, t]);

  // The canvas always fits its frame until the designer zooms deliberately.
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return undefined;
    const measure = () => {
      const width = frame.clientWidth - 24;
      setFitScale(Math.max(Math.min(width / (Number(template.page_width_px) || 1123), 1), 0.12));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    return () => observer.disconnect();
  }, [template.page_width_px]);

  const selectedField = fields.find((field) => keyOf(field) === selectedKey) || null;

  const patchTemplate = (patch) => setTemplate((current) => ({ ...current, ...patch }));

  const patchField = (key, patch) => setFields((current) => current.map((field) => (
    keyOf(field) === key ? { ...field, ...patch } : field
  )));

  // ---- drag & drop --------------------------------------------------------

  const inlineStartOf = useCallback((clientX, rect) => (isRtl ? rect.right - clientX : clientX - rect.left), [isRtl]);

  const storedX = useCallback((startPx, width, anchor, pageWidth) => {
    if (anchor === 'TopEnd') return pageWidth - (startPx + width);
    if (anchor === 'TopCenter') return startPx + width / 2 - pageWidth / 2;
    return startPx;
  }, []);

  const onFieldPointerDown = (field, event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const page = pageRef.current;
    if (!page) return;

    const pageRect = page.getBoundingClientRect();
    const fieldRect = event.currentTarget.getBoundingClientRect();
    const pointerStart = inlineStartOf(event.clientX, pageRect);
    const fieldStart = isRtl ? pageRect.right - fieldRect.right : fieldRect.left - pageRect.left;

    dragRef.current = {
      key: keyOf(field),
      anchor: field.anchor,
      grabX: (pointerStart - fieldStart) / scale,
      grabY: (event.clientY - fieldRect.top) / scale,
      width: fieldRect.width / scale,
      height: fieldRect.height / scale,
    };

    event.currentTarget.setPointerCapture?.(event.pointerId);
    setSelectedKey(keyOf(field));
  };

  const onFieldPointerMove = (event) => {
    const drag = dragRef.current;
    const page = pageRef.current;
    if (!drag || !page) return;

    const pageWidth = Number(template.page_width_px) || 1123;
    const pageHeight = Number(template.page_height_px) || 794;
    const pageRect = page.getBoundingClientRect();

    let startPx = inlineStartOf(event.clientX, pageRect) / scale - drag.grabX;
    let topPx = (event.clientY - pageRect.top) / scale - drag.grabY;

    if (snapGrid) {
      startPx = Math.round(startPx / 10) * 10;
      topPx = Math.round(topPx / 10) * 10;
    }
    if (snapCenter) {
      const centred = (pageWidth - drag.width) / 2;
      if (Math.abs(startPx - centred) <= 12) startPx = centred;
      const middle = (pageHeight - drag.height) / 2;
      if (Math.abs(topPx - middle) <= 12) topPx = middle;
    }

    startPx = clamp(startPx, 0, pageWidth - drag.width);
    topPx = clamp(topPx, 0, pageHeight - drag.height);

    patchField(drag.key, {
      pos_x_px: round(storedX(startPx, drag.width, drag.anchor, pageWidth)),
      pos_y_px: round(topPx),
    });
  };

  const endDrag = () => { dragRef.current = null; };

  const onFieldKeyDown = (field, event) => {
    const step = event.shiftKey ? 10 : 1;
    const horizontal = { ArrowRight: step, ArrowLeft: -step };
    const vertical = { ArrowDown: step, ArrowUp: -step };

    if (horizontal[event.key] !== undefined) {
      event.preventDefault();
      const visual = horizontal[event.key];
      const inlineDelta = isRtl ? -visual : visual;
      const delta = field.anchor === 'TopEnd' ? -inlineDelta : inlineDelta;
      patchField(keyOf(field), { pos_x_px: round(Number(field.pos_x_px) + delta) });
      return;
    }
    if (vertical[event.key] !== undefined) {
      event.preventDefault();
      patchField(keyOf(field), { pos_y_px: round(Number(field.pos_y_px) + vertical[event.key]) });
    }
  };

  // ---- actions ------------------------------------------------------------

  const createTemplate = () => {
    setSelectedId(null);
    setTemplate({ ...emptyTemplate(), code: `TPL${String(templates.length + 1).padStart(2, '0')}` });
    setFields([]);
    setSelectedKey(null);
    setNotice(null);
  };

  const addField = () => {
    const field = newField(fields.length);
    setFields((current) => [...current, field]);
    setSelectedKey(keyOf(field));
  };

  const removeField = (key) => {
    setFields((current) => current.filter((field) => keyOf(field) !== key));
    setSelectedKey(null);
  };

  const uploadBackground = async (file) => {
    setUploading(true);
    const { data, error } = await uploadVerificationFile({
      tenantId: tenant?.id,
      area: 'certificate-templates',
      file,
      entityType: 'CertificateTemplate',
      entityId: template.id,
    });
    setUploading(false);
    if (error) {
      setNotice({ tone: 'error', text: t(verificationErrorKey(error)) });
      return;
    }
    patchTemplate({ background_url: data.url });
  };

  const save = async () => {
    setBusy(true);
    setNotice(null);

    const { data: saved, error } = await saveTemplate(template);
    if (error) {
      setBusy(false);
      setNotice({ tone: 'error', text: t(verificationErrorKey(error)) });
      return;
    }

    const { error: fieldError } = await saveTemplateFields(saved.id, fields);
    setBusy(false);
    if (fieldError) {
      setNotice({ tone: 'error', text: t(verificationErrorKey(fieldError)) });
      return;
    }

    setNotice({ tone: 'success', text: t('vf_designer_saved') });
    await refreshTemplates(saved.id);
  };

  const removeTemplate = async () => {
    if (!template.id) return;

    setConfirmDelete(false);
    setBusy(true);
    const { error } = await deleteTemplate(template.id);
    setBusy(false);
    if (error) {
      setNotice({ tone: 'error', text: t(verificationErrorKey(error)) });
      return;
    }
    setSelectedId(null);
    await refreshTemplates(null);
  };

  const sampleValues = useMemo(() => {
    if (!preview) return {};
    return fields.reduce((values, field) => {
      const key = field.field_key.toLowerCase();
      let value = field.default_value || '';
      if (!value) {
        if (field.field_type === 'Date') value = new Date().toISOString();
        else if (field.field_type === 'Number') value = 100;
        else if (key.includes('name')) value = t('vf_sample_name');
        else if (key.includes('course') || key.includes('program')) value = t('vf_sample_course');
        else if (field.field_type === 'Text') value = t('vf_sample_text');
      }
      return { ...values, [field.field_key]: value };
    }, {});
  }, [preview, fields, t]);

  return (
    <div className="vf-designer">
      <div className="vf-screen-head">
        <div>
          <span className="section-kicker">{t('module_certificates')}</span>
          <h1>{t('vf_designer_title')}</h1>
          <p>{t('vf_designer_intro')}</p>
        </div>
        <div className="vf-inline-actions">
          <button type="button" className="secondary-button" onClick={createTemplate}>
            <Plus aria-hidden="true" /> {t('vf_tpl_new')}
          </button>
          <button type="button" className="primary-button" onClick={save} disabled={busy}>
            {busy ? <Loader2 className="vf-spin" aria-hidden="true" /> : <Save aria-hidden="true" />}
            {t('action_save')}
          </button>
        </div>
      </div>

      {notice && (
        <div className={`inline-message ${notice.tone === 'error' ? 'error' : ''}`} role="status" aria-live="polite">
          {notice.text}
          <button type="button" onClick={() => setNotice(null)} aria-label={t('action_close')}>
            <X aria-hidden="true" />
          </button>
        </div>
      )}

      <div className="vf-designer-layout">
        <div className="vf-designer-side">
          <TemplateList
            templates={templates}
            selectedId={selectedId}
            onSelect={(id) => openTemplate(templates.find((row) => row.id === id) || null)}
            onCreate={createTemplate}
          />
          <TemplateSettings
            template={template}
            onChange={patchTemplate}
            onUploadBackground={uploadBackground}
            onDelete={() => setConfirmDelete(true)}
            uploading={uploading}
          />
        </div>

        <div className="vf-designer-stage">
          <div className="vf-canvas-toolbar">
            <div className="vf-inline-actions">
              <button type="button" className="icon-button" onClick={() => setZoom(Math.max((zoom ?? fitScale) - 0.1, 0.15))} aria-label={t('vf_zoom_out')} title={t('vf_zoom_out')}>
                <ZoomOut aria-hidden="true" />
              </button>
              <span className="vf-zoom-value" aria-live="polite">{Math.round(scale * 100)}%</span>
              <button type="button" className="icon-button" onClick={() => setZoom(Math.min((zoom ?? fitScale) + 0.1, 2))} aria-label={t('vf_zoom_in')} title={t('vf_zoom_in')}>
                <ZoomIn aria-hidden="true" />
              </button>
              <button type="button" className="secondary-button" onClick={() => setZoom(null)}>{t('vf_zoom_fit')}</button>
            </div>

            <div className="vf-toolbar-toggles">
              <label className="vf-toggle-label">
                <input type="checkbox" checked={snapGrid} onChange={(event) => setSnapGrid(event.target.checked)} />
                {t('vf_snap_grid')}
              </label>
              <label className="vf-toggle-label">
                <input type="checkbox" checked={snapCenter} onChange={(event) => setSnapCenter(event.target.checked)} />
                {t('vf_snap_center')}
              </label>
              <label className="vf-toggle-label">
                <input type="checkbox" checked={preview} onChange={(event) => setPreview(event.target.checked)} />
                <Eye aria-hidden="true" size={14} /> {t('vf_preview_sample')}
              </label>
            </div>
          </div>

          <p className="field-note vf-drag-hint"><Move aria-hidden="true" size={14} /> {t('vf_drag_hint')}</p>

          <div
            className="vf-canvas-frame"
            ref={frameRef}
            onPointerMove={onFieldPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          >
            <CertificateCanvas
              template={template}
              fields={fields}
              values={sampleValues}
              code={preview ? sampleCode : ''}
              scale={scale}
              interactive
              selectedKey={selectedKey}
              showGrid={snapGrid}
              pageRef={pageRef}
              onFieldPointerDown={onFieldPointerDown}
              onFieldKeyDown={onFieldKeyDown}
              onSelectField={setSelectedKey}
            />
          </div>
        </div>

        <div className="vf-designer-side">
          <section className="vf-panel">
            <div className="vf-panel-head">
              <h2>{t('vf_fields_title')}</h2>
              <button type="button" className="secondary-button" onClick={addField}>
                <Plus aria-hidden="true" /> {t('vf_add_field')}
              </button>
            </div>

            {fields.length === 0 ? (
              <div className="empty-table compact">
                <LayoutTemplate aria-hidden="true" />
                <b>{t('vf_no_fields')}</b>
                <span>{t('vf_no_fields_hint')}</span>
              </div>
            ) : (
              <ul className="vf-field-items">
                {fields.map((field) => (
                  <li key={keyOf(field)}>
                    <button
                      type="button"
                      className={selectedKey === keyOf(field) ? 'active' : ''}
                      onClick={() => setSelectedKey(keyOf(field))}
                      aria-current={selectedKey === keyOf(field) ? 'true' : undefined}
                    >
                      <b>{pickLocalized(field, 'label', lang, field.field_key)}</b>
                      <small dir="ltr">{field.field_key}</small>
                      <span className="vf-chip tone-neutral">{t(TYPE_LABEL_KEYS[field.field_type])}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <FieldInspector
            field={selectedField}
            onChange={(patch) => patchField(selectedKey, patch)}
            onDelete={() => removeField(selectedKey)}
          />
        </div>
      </div>

      {confirmDelete && (
        <div className="modal-backdrop" role="presentation" onClick={() => setConfirmDelete(false)}>
          <div
            className="modal-card confirm-modal"
            role="dialog"
            aria-modal="true"
            aria-label={t('vf_tpl_delete')}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-heading">
              <h3>{t('vf_tpl_delete')}</h3>
              <button type="button" className="icon-button" onClick={() => setConfirmDelete(false)} aria-label={t('action_close')}>
                <X aria-hidden="true" />
              </button>
            </div>
            <div className="confirm-body">
              <AlertTriangle aria-hidden="true" />
              <p>{t('vf_tpl_delete_confirm')}</p>
            </div>
            <div className="modal-actions">
              <button type="button" className="secondary-button" onClick={() => setConfirmDelete(false)}>
                {t('action_cancel')}
              </button>
              <button type="button" className="primary-button" onClick={removeTemplate} disabled={busy}>
                <Trash2 aria-hidden="true" /> {t('action_delete')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default CertificateDesigner;

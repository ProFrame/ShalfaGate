// Digital Identity — the employee's own digital business card.
//
// Backing objects (migration 202608060049):
//   public.employee_cards
//   RPCs: card_get_mine, card_save_settings, card_public_view, card_track_event
//
// Nothing here throws: every function resolves with { data, error } so a
// screen can always decide what to render. In local preview (`useLocalData`)
// the same API is served from a localStorage mirror.

import { supabase, useLocalData } from '../lib/supabaseClient';
import { pickFromMap } from '../utils/localize';

export const VISIBILITY_OPTIONS = ['Private', 'CompanyOnly', 'Public'];
export const TEMPLATE_OPTIONS = ['Classic', 'Modern', 'Minimal', 'Bold'];
export const THEME_OPTIONS = ['Light', 'Dark'];
export const SHAPE_OPTIONS = ['Rounded', 'Square'];

/** Fields the owner may individually hide from viewers who can otherwise see the card. */
export const TOGGLEABLE_FIELDS = ['mobile', 'email', 'extension_phone', 'linkedin_url', 'department_ar', 'site_ar', 'project_ar'];

const ok = (data) => ({ data, error: null });
const fail = (error) => ({ data: null, error: error instanceof Error ? error : new Error(String(error)) });

const OWN_ERROR_KEYS = [
  'NO_ACTIVE_TENANT', 'INVALID_VISIBILITY', 'INVALID_TEMPLATE', 'INVALID_THEME',
  'INVALID_SHAPE', 'INVALID_EVENT_TYPE', 'CARD_CODE_ALLOCATION_FAILED', 'INVALID_LINKEDIN_URL',
];

/** Maps whatever came back onto a translation key the screens can render. */
export const identityErrorKey = (error) => {
  if (!error) return 'error_generic';
  const code = String(error.message || error.code || error).split('\n')[0].trim().toUpperCase();
  if (OWN_ERROR_KEYS.includes(code)) return `di_err_${code.toLowerCase()}`;
  if (code === 'PERMISSION_DENIED') return 'error_permission';
  return 'error_generic';
};

const DEMO_KEY = 'bbnovix_digital_identity_demo';

const readDemo = () => {
  try {
    return JSON.parse(localStorage.getItem(DEMO_KEY)) || { card: null };
  } catch {
    return { card: null };
  }
};

const writeDemo = (state) => localStorage.setItem(DEMO_KEY, JSON.stringify(state));

const demoCard = () => {
  const state = readDemo();
  if (!state.card) {
    state.card = {
      id: 'demo-card', card_no: 'NO-DEMO-ID-00000001', public_code: 'DEMO-100000000000',
      visibility: 'CompanyOnly', template_code: 'Classic', theme: 'Light', shape: 'Rounded',
      show_logo: true, show_photo: true, linkedin_url: '', extension_phone: '',
      field_visibility: {}, opens_count: 0, vcf_downloads_count: 0, website_clicks_count: 0,
      calls_count: 0, emails_count: 0,
      profile: {
        full_name: 'Demo Employee', name_ar: 'موظف تجريبي', name_en: 'Demo Employee',
        job_title: 'Employee', job_title_ar: 'موظف', job_title_en: 'Employee',
        email: 'demo@example.com', mobile: '0500000000', avatar_url: null,
        department_ar: null, department_en: null, site_ar: null, site_en: null, project_ar: null, project_en: null,
      },
      company: { names: { ar: 'شركة تجريبية', en: 'Demo Company' }, logo_light_url: null, logo_dark_url: null, website_url: null, primary_color: '#0f766e' },
    };
    writeDemo(state);
  }
  return state.card;
};

/** Loads (creating on first call) the caller's own card. */
export const loadMyCard = async () => {
  if (useLocalData || !supabase) return ok(demoCard());
  try {
    const { data, error } = await supabase.rpc('card_get_mine');
    if (error) return fail(error);
    return ok(data);
  } catch (thrown) {
    return fail(thrown);
  }
};

/**
 * @param {{visibility?, template_code?, theme?, shape?, show_logo?, show_photo?,
 *   linkedin_url?, extension_phone?, field_visibility?}} settings
 */
export const saveMyCard = async (settings) => {
  if (useLocalData || !supabase) {
    const state = readDemo();
    state.card = { ...demoCard(), ...settings };
    writeDemo(state);
    return ok(state.card);
  }
  try {
    const { data, error } = await supabase.rpc('card_save_settings', { p_payload: settings });
    if (error) return fail(error);
    return ok(data);
  } catch (thrown) {
    return fail(thrown);
  }
};

/** Anonymous/public read of a card by its public code. */
export const loadPublicCard = async (code) => {
  if (!code) return ok({ found: false });
  if (useLocalData || !supabase) {
    const card = demoCard();
    if (card.public_code !== code) return ok({ found: false });
    return ok({ found: true, ...card });
  }
  try {
    const { data, error } = await supabase.rpc('card_public_view', { p_code: code });
    if (error) return fail(error);
    return ok(data);
  } catch (thrown) {
    return fail(thrown);
  }
};

/** @param {'vcf_download'|'website_click'|'call'|'email'} eventType */
export const trackCardEvent = async (code, eventType) => {
  if (!code) return ok(null);
  if (useLocalData || !supabase) return ok(null);
  try {
    const { error } = await supabase.rpc('card_track_event', { p_code: code, p_event_type: eventType });
    if (error) return fail(error);
    return ok(null);
  } catch (thrown) {
    return fail(thrown);
  }
};

/** Builds a vCard 3.0 file (widest client support) from a card's own data. */
export const buildVcf = (card, lang) => {
  const p = card.profile || {};
  const name = (lang === 'ar' ? p.name_ar : p.name_en) || p.full_name || '';
  const title = (lang === 'ar' ? p.job_title_ar : p.job_title_en) || p.job_title || '';
  const org = pickFromMap(card.company?.names, lang);
  const escape = (value) => String(value || '').replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n');
  const lines = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `FN:${escape(name)}`,
    `N:${escape(name)};;;;`,
    title ? `TITLE:${escape(title)}` : null,
    org ? `ORG:${escape(org)}` : null,
    p.email ? `EMAIL:${escape(p.email)}` : null,
    p.mobile ? `TEL;TYPE=CELL:${escape(p.mobile)}` : null,
    card.extension_phone ? `TEL;TYPE=WORK:${escape(card.extension_phone)}` : null,
    card.linkedin_url ? `URL:${escape(card.linkedin_url)}` : null,
    card.public_code ? `NOTE:${escape('bbnovix')}` : null,
    'END:VCARD',
  ].filter(Boolean);
  return lines.join('\r\n');
};

/** Builds and downloads the vCard as a file — the one download implementation, shared by MyCardScreen and PublicCardPage. */
export const downloadVcfFile = (card, lang) => {
  const vcf = buildVcf(card, lang);
  const blob = new Blob([vcf], { type: 'text/vcard' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${card.profile?.full_name || 'card'}.vcf`;
  link.click();
  URL.revokeObjectURL(url);
};

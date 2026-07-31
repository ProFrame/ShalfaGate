import { supabase, useLocalData } from '../lib/supabaseClient';

const LOCAL_KEY = 'shalfa_performance_libraries';

const readLocal = () => {
  try {
    return JSON.parse(localStorage.getItem(LOCAL_KEY)) || {};
  } catch {
    return {};
  }
};

const writeLocal = (key, rows) => {
  localStorage.setItem(LOCAL_KEY, JSON.stringify({ ...readLocal(), [key]: rows }));
};

export const loadLibrary = async (kind, fallback = []) => {
  if (useLocalData) return readLocal()[kind] || fallback;
  const table = kind === 'proficiency' ? 'proficiency_levels' : kind;
  let query = supabase.from(table).select(kind === 'competencies' ? '*, competency_indicators(*)' : '*');
  query = query.eq('is_deleted', false);
  const orderColumn = kind === 'proficiency' ? 'level_no' : 'display_order';
  const { data, error } = await query.order(orderColumn);
  if (error) throw error;
  return data || [];
};

export const saveLibraryItem = async (kind, item, currentRows = []) => {
  if (useLocalData) {
    const saved = { ...item, id: item.id || crypto.randomUUID() };
    const next = currentRows.some((row) => row.id === saved.id)
      ? currentRows.map((row) => row.id === saved.id ? saved : row)
      : [saved, ...currentRows];
    writeLocal(kind, next);
    return saved;
  }

  const table = kind === 'proficiency' ? 'proficiency_levels' : kind;
  const payload = { ...item };
  const indicators = payload.indicators;
  delete payload.indicators;
  delete payload.competency_indicators;
  delete payload.parent;
  const { data, error } = await supabase.from(table).upsert(payload).select().single();
  if (error) throw error;

  if (kind === 'competencies' && Array.isArray(indicators)) {
    await supabase.from('competency_indicators').update({ is_deleted: true }).eq('competency_id', data.id);
    if (indicators.length) {
      const rows = indicators.map((indicator, index) => ({
        competency_id: data.id,
        indicator_order: index + 1,
        text_ar: indicator.text_ar || '',
        text_en: indicator.text_en || '',
        is_active: true,
        is_deleted: false,
      }));
      const { error: indicatorError } = await supabase.from('competency_indicators').insert(rows);
      if (indicatorError) throw indicatorError;
    }
  }
  return data;
};

export const setLibraryItemActive = async (kind, item, active, currentRows = []) => {
  return saveLibraryItem(kind, { ...item, is_active: active, active }, currentRows);
};

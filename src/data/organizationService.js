import { supabase, useLocalData } from '../lib/supabaseClient';

const storageKey = 'bbnovix_organization_lookups';

const previewData = {
  departments: [
    { id: 'dept-hr', code: 'HR', name_ar: 'الموارد البشرية', name_en: 'Human Resources', display_order: 10, is_active: true },
    { id: 'dept-fin', code: 'FIN', name_ar: 'المالية', name_en: 'Finance', display_order: 20, is_active: true },
    { id: 'dept-ops', code: 'OPS', name_ar: 'التشغيل', name_en: 'Operations', display_order: 30, is_active: true },
    { id: 'dept-it', code: 'IT', name_ar: 'تقنية المعلومات', name_en: 'Information Technology', display_order: 40, is_active: true },
  ],
  positions: [
    { id: 'pos-hr', code: 'HR-SPEC', name_ar: 'أخصائي موارد بشرية', name_en: 'HR Specialist', department_id: 'dept-hr', display_order: 10, is_active: true },
    { id: 'pos-accountant', code: 'FIN-ACC', name_ar: 'محاسب أول', name_en: 'Senior Accountant', department_id: 'dept-fin', display_order: 20, is_active: true },
    { id: 'pos-project-manager', code: 'OPS-PM', name_ar: 'مدير مشروع', name_en: 'Project Manager', department_id: 'dept-ops', display_order: 30, is_active: true },
  ],
};

const readPreview = () => {
  const stored = JSON.parse(localStorage.getItem(storageKey) || 'null');
  return stored || previewData;
};

const writePreview = (value) => localStorage.setItem(storageKey, JSON.stringify(value));

export async function loadOrganizationLookups() {
  if (useLocalData) return readPreview();
  const [departments, positions] = await Promise.all([
    supabase.from('departments').select('*').eq('is_deleted', false).order('display_order').order('name_ar'),
    supabase.from('positions').select('*, departments(id,code,name_ar,name_en)').eq('is_deleted', false).order('display_order').order('name_ar'),
  ]);
  if (departments.error) throw departments.error;
  if (positions.error) throw positions.error;
  return { departments: departments.data || [], positions: positions.data || [] };
}

export async function saveOrganizationItem(kind, item) {
  const table = kind === 'departments' ? 'departments' : 'positions';
  const payload = {
    code: String(item.code || '').trim().toUpperCase(),
    name_ar: String(item.name_ar || '').trim(),
    name_en: String(item.name_en || '').trim() || null,
    description_ar: String(item.description_ar || '').trim() || null,
    description_en: String(item.description_en || '').trim() || null,
    display_order: Number(item.display_order || 0),
    is_active: item.is_active !== false,
  };
  if (kind === 'positions') payload.department_id = item.department_id || null;

  if (useLocalData) {
    const data = readPreview();
    const id = item.id || crypto.randomUUID();
    data[kind] = [{ ...item, ...payload, id }, ...data[kind].filter((row) => row.id !== id)];
    writePreview(data);
    return { ...item, ...payload, id };
  }

  if (item.id) payload.id = item.id;
  const { data, error } = await supabase.from(table).upsert(payload).select().single();
  if (error) throw error;
  return data;
}

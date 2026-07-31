import { supabase, useLocalData } from '../lib/supabaseClient';

const previewStorageKey = 'shalfa_content_preview';

const mapContentItem = (item) => ({
  ...item,
  name: item.title_ar,
  name_ar: item.title_ar,
  name_en: item.title_en,
  name_hi: item.title_hi,
  name_ur: item.title_ur,
  name_tl: item.title_tl,
  url: item.external_url || item.preview_path || item.storage_path,
  type: item.file_type || (item.content_type === 'Design' ? 'image' : 'pdf'),
  size: item.file_size || '',
  date: item.publish_date?.slice?.(0, 10) || item.created_on?.slice?.(0, 10) || '',
  publication_level: item.publication_level || 'PUBLIC',
});

const typeToKey = {
  Document: 'documents',
  Circular: 'circulars',
  Design: 'designs',
};

const groupContent = (rows) => rows.reduce((grouped, item) => {
  const key = typeToKey[item.content_type];
  if (key) grouped[key].push(mapContentItem(item));
  return grouped;
}, { documents: [], circulars: [], designs: [] });

const readPreviewContent = async () => {
  const saved = localStorage.getItem(previewStorageKey);
  if (saved) return JSON.parse(saved);
  const response = await fetch(`${import.meta.env.BASE_URL}data/site-data.json?t=${Date.now()}`);
  if (!response.ok) throw new Error(`Content request failed: ${response.status}`);
  const source = await response.json();
  const rows = [
    ...(source.documents || []).map((item, index) => ({
      ...item,
      id: item.id,
      code: `DOC-${String(index + 1).padStart(3, '0')}`,
      content_type: 'Document',
      title_ar: item.name,
      title_en: item.name,
      external_url: item.url,
      file_type: item.type,
      file_size: item.size,
      publish_date: item.date,
      display_order: index + 1,
      is_published: true,
      publication_level: 'PUBLIC',
    })),
    ...(source.circulars || []).map((item, index) => ({
      ...item,
      id: item.id,
      code: `CIR-${String(index + 1).padStart(3, '0')}`,
      content_type: 'Circular',
      title_ar: item.name,
      title_en: item.name,
      external_url: item.url,
      file_type: item.type,
      file_size: item.size,
      publish_date: item.date,
      display_order: index + 1,
      is_published: true,
      publication_level: 'PUBLIC',
    })),
    ...(source.designs || []).map((item, index) => ({
      ...item,
      id: item.id,
      code: `DSN-${String(index + 1).padStart(3, '0')}`,
      content_type: 'Design',
      title_ar: item.name,
      title_en: item.name,
      external_url: item.url,
      file_type: item.type,
      file_size: item.size,
      publish_date: item.date,
      display_order: index + 1,
      is_published: true,
      publication_level: 'PUBLIC',
    })),
  ];
  localStorage.setItem(previewStorageKey, JSON.stringify(rows));
  return rows;
};

export async function loadPublishedContent() {
  if (useLocalData) return groupContent(await readPreviewContent());
  const { data, error } = await supabase
    .from('content_items')
    .select('*')
    .eq('is_published', true)
    .eq('is_deleted', false)
    .order('display_order')
    .order('publish_date', { ascending: false });
  if (error) throw error;
  return groupContent(data || []);
}

export async function loadManagedContent() {
  if (useLocalData) return readPreviewContent();
  const { data, error } = await supabase
    .from('content_items')
    .select('*')
    .eq('is_deleted', false)
    .order('content_type')
    .order('display_order');
  if (error) throw error;
  return data || [];
}

export async function saveContentItem(item) {
  const payload = {
    content_type: item.content_type,
    code: item.code?.trim() || null,
    title_ar: item.title_ar.trim(),
    title_en: item.title_en?.trim() || null,
    title_hi: item.title_hi?.trim() || null,
    title_ur: item.title_ur?.trim() || null,
    title_tl: item.title_tl?.trim() || null,
    description_ar: item.description_ar?.trim() || null,
    description_en: item.description_en?.trim() || null,
    external_url: item.external_url?.trim() || null,
    file_type: item.file_type || 'pdf',
    file_size: item.file_size?.trim() || null,
    category: item.category?.trim() || null,
    version: item.version?.trim() || null,
    priority: item.priority || 'Normal',
    publication_level: item.publication_level || 'PUBLIC',
    publish_date: item.publish_date || new Date().toISOString(),
    expiry_date: item.expiry_date || null,
    requires_acknowledgement: Boolean(item.requires_acknowledgement),
    is_published: Boolean(item.is_published),
    display_order: Number(item.display_order || 0),
    updated_on: new Date().toISOString(),
  };

  if (useLocalData) {
    const rows = await readPreviewContent();
    const id = item.id || crypto.randomUUID();
    const next = [{ ...item, ...payload, id }, ...rows.filter((row) => row.id !== id)];
    localStorage.setItem(previewStorageKey, JSON.stringify(next));
    return { ...item, ...payload, id };
  }

  const query = item.id
    ? supabase.from('content_items').update(payload).eq('id', item.id)
    : supabase.from('content_items').insert(payload);
  const { data, error } = await query.select().single();
  if (error) throw error;
  return data;
}

export async function deleteContentItem(id) {
  if (useLocalData) {
    const rows = await readPreviewContent();
    localStorage.setItem(previewStorageKey, JSON.stringify(rows.filter((row) => row.id !== id)));
    return;
  }
  const { error } = await supabase
    .from('content_items')
    .update({ is_deleted: true, deleted_date: new Date().toISOString() })
    .eq('id', id);
  if (error) throw error;
}

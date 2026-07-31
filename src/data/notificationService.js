import { supabase, useLocalData } from '../lib/supabaseClient';
import { loadPublishedContent } from './contentService';

const readKey = (userId) => `shalfa_notification_reads_${userId || 'anonymous'}`;
const readIds = (userId) => new Set(JSON.parse(localStorage.getItem(readKey(userId)) || '[]'));

const contentNotification = (item, module) => ({
  id: `content:${item.id}`,
  type: module === 'circulars' ? 'circular' : 'content',
  module,
  title_ar: item.name_ar || item.name,
  title_en: item.name_en || item.name,
  messageKey: module === 'circulars' ? 'notification_circular_published' : 'notification_content_published',
  priority: item.priority || 'Normal',
  createdAt: item.date || item.publish_date,
  href: `/app/${module}`,
});

export async function loadNotifications(userId) {
  const notifications = [];
  const recentCutoff = Date.now() - (30 * 24 * 60 * 60 * 1000);
  const isRecent = (value) => {
    const timestamp = value ? new Date(value).getTime() : 0;
    return Number.isFinite(timestamp) && timestamp >= recentCutoff;
  };
  try {
    const content = await loadPublishedContent();
    ['circulars', 'documents', 'designs'].forEach((module) => {
      (content[module] || []).filter((item) => isRecent(item.date || item.publish_date)).slice(0, module === 'circulars' ? 4 : 2).forEach((item) => {
        notifications.push(contentNotification(item, module));
      });
    });
  } catch {
    // A content outage must not block the application header.
  }

  try {
    let forms;
    if (useLocalData) {
      forms = JSON.parse(localStorage.getItem('shalfa_forms_demo') || '[]');
    } else {
      const result = await supabase
        .from('forms')
        .select('id,status,updated_on,templates(name,name_ar,name_en,code)')
        .or(`requested_by.eq.${userId},employee_id.eq.${userId}`)
        .in('status', ['Returned', 'Submitted'])
        .order('updated_on', { ascending: false })
        .limit(10);
      forms = result.error ? [] : result.data;
    }
    (forms || []).filter((form) => isRecent(form.updated_on || form.updatedAt)).forEach((form) => {
      notifications.push({
        id: `form:${form.id}:${form.status}`,
        type: 'form',
        module: 'forms',
        title_ar: form.templates?.name_ar || form.templates?.name || form.reference_no,
        title_en: form.templates?.name_en || form.templates?.name || form.reference_no,
        messageKey: form.status === 'Returned' ? 'notification_form_returned' : 'notification_form_submitted',
        priority: form.status === 'Returned' ? 'High' : 'Normal',
        createdAt: form.updated_on,
        href: '/app/forms',
      });
    });
  } catch {
    // Notifications remain available even if one source is temporarily unavailable.
  }

  try {
    let awaiting;
    if (useLocalData) {
      awaiting = JSON.parse(localStorage.getItem('shalfa_forms_demo') || '[]')
        .filter((form) => form.current_assignee_id === userId && form.status === 'InApproval');
    } else {
      const result = await supabase
        .from('forms')
        .select('id,status,pending_since,reference_no,templates(name,name_ar,name_en,code)')
        .eq('current_assignee_id', userId)
        .eq('status', 'InApproval')
        .order('pending_since', { ascending: false })
        .limit(10);
      awaiting = result.error ? [] : result.data;
    }
    (awaiting || []).forEach((form) => {
      notifications.push({
        id: `approval:${form.id}:${form.pending_since || ''}`,
        type: 'approval',
        module: 'approvals',
        title_ar: form.templates?.name_ar || form.templates?.name || form.reference_no,
        title_en: form.templates?.name_en || form.templates?.name || form.reference_no,
        messageKey: 'notification_awaiting_action',
        priority: 'High',
        createdAt: form.pending_since,
        href: '/app/approvals',
      });
    });
  } catch {
    // The approval feed must never block the header.
  }

  const seen = readIds(userId);
  return notifications
    .map((item) => ({ ...item, read: seen.has(item.id) }))
    .sort((a, b) => {
      if (a.read !== b.read) return a.read ? 1 : -1;
      if (a.priority !== b.priority) return a.priority === 'High' ? -1 : 1;
      return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
    })
    .slice(0, 12);
}

export function markNotificationRead(userId, id) {
  const seen = readIds(userId);
  seen.add(id);
  localStorage.setItem(readKey(userId), JSON.stringify([...seen]));
}

export function markAllNotificationsRead(userId, notifications) {
  const seen = readIds(userId);
  notifications.forEach((item) => seen.add(item.id));
  localStorage.setItem(readKey(userId), JSON.stringify([...seen]));
}

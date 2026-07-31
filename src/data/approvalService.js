import { supabase, useLocalData } from '../lib/supabaseClient';

// ---------------------------------------------------------------------------
// Demo (preview) engine: mirrors the server-side Dynamic Approval Chain so the
// feature stays usable with `?preview=1` / no Supabase configuration.
// ---------------------------------------------------------------------------
const FORMS_KEY = 'shalfa_forms_demo';
const TX_KEY = 'shalfa_approvals_demo';
const DEMO_USER_ID = 'demo-user';

const demoRoles = [
  { id: 'role-requester', code: 'REQUESTER', name_ar: 'منشئ الطلب', name_en: 'Requester', display_order: 0, is_active: true, is_system: true },
  { id: 'role-manager', code: 'DIRECT_MANAGER', name_ar: 'المدير المباشر', name_en: 'Direct Manager', display_order: 10, is_active: true, is_system: true },
  { id: 'role-hr', code: 'HR', name_ar: 'الموارد البشرية', name_en: 'Human Resources', display_order: 20, is_active: true, is_system: true },
  { id: 'role-recommendation', code: 'RECOMMENDATION', name_ar: 'التوصية', name_en: 'Recommendation', display_order: 30, is_active: true, is_system: true },
  { id: 'role-warehouse', code: 'WAREHOUSE_OFFICER', name_ar: 'مسؤول المستودع', name_en: 'Warehouse Officer', display_order: 40, is_active: true, is_system: true },
  { id: 'role-purchasing', code: 'PURCHASING_MANAGER', name_ar: 'مدير المشتريات', name_en: 'Purchasing Manager', display_order: 50, is_active: true, is_system: true },
  { id: 'role-approval', code: 'FINAL_APPROVAL', name_ar: 'الاعتماد', name_en: 'Final Approval', display_order: 60, is_active: true, is_system: true },
];

const demoSchemes = [
  {
    id: 'scheme-standard', code: 'STANDARD', name_ar: 'الاعتماد القياسي', name_en: 'Standard Approval', is_active: true,
    roles: ['role-requester', 'role-recommendation', 'role-approval'],
  },
  {
    id: 'scheme-hr', code: 'HR_CHAIN', name_ar: 'سلسلة الموارد البشرية', name_en: 'HR Chain', is_active: true,
    roles: ['role-requester', 'role-manager', 'role-hr', 'role-approval'],
  },
  {
    id: 'scheme-purchasing', code: 'PURCHASING_CHAIN', name_ar: 'سلسلة المشتريات', name_en: 'Purchasing Chain', is_active: true,
    roles: ['role-requester', 'role-warehouse', 'role-purchasing'],
  },
];

const demoDirectory = [
  { id: DEMO_USER_ID, employee_no: '10001', full_name: 'أحمد محمد', name_ar: 'أحمد محمد', name_en: 'Ahmed Mohammed', department: 'الموارد البشرية' },
  { id: 'demo-employee-2', employee_no: '10024', full_name: 'سارة خالد', name_ar: 'سارة خالد', name_en: 'Sara Khalid', department: 'المالية' },
  { id: 'demo-employee-3', employee_no: '10113', full_name: 'محمد علي', name_ar: 'محمد علي', name_en: 'Mohammed Ali', department: 'التشغيل' },
];

const readForms = () => JSON.parse(localStorage.getItem(FORMS_KEY) || '[]');
const writeForms = (forms) => localStorage.setItem(FORMS_KEY, JSON.stringify(forms));
const readTx = () => JSON.parse(localStorage.getItem(TX_KEY) || '{}');
const writeTx = (map) => localStorage.setItem(TX_KEY, JSON.stringify(map));

const demoRole = (id) => demoRoles.find((role) => role.id === id) || null;
const demoUser = (id) => demoDirectory.find((user) => user.id === id) || { id, full_name: 'مستخدم' };
const demoSchemeRoles = (schemeId) => {
  const scheme = demoSchemes.find((item) => item.id === schemeId) || demoSchemes[0];
  return {
    ...scheme,
    roles: scheme.roles.map((roleId, index) => ({ ...demoRole(roleId), display_order: index + 1, is_required: true })),
  };
};

const demoVerifyCode = () => String(Math.floor(Math.random() * 8e14) + 1e14);

const demoAppendTx = (formId, tx) => {
  const map = readTx();
  const list = map[formId] || [];
  const actor = demoUser(tx.actor_id);
  const role = tx.role_id ? demoRole(tx.role_id) : null;
  list.push({
    id: crypto.randomUUID(),
    seq: list.length + 1,
    form_id: formId,
    actor_name: actor.full_name,
    actor_signature_url: actor.signature_url || null,
    role_code: role?.code || null,
    role_name_ar: role?.name_ar || null,
    role_name_en: role?.name_en || null,
    to_user_name: tx.to_user_id ? demoUser(tx.to_user_id).full_name : null,
    created_on: new Date().toISOString(),
    ...tx,
  });
  map[formId] = list;
  writeTx(map);
  return list;
};

const demoUpdateForm = (formId, patch) => {
  const forms = readForms();
  const next = forms.map((item) => (item.id === formId ? { ...item, ...patch, updated_on: new Date().toISOString() } : item));
  writeForms(next);
  return next.find((item) => item.id === formId);
};

const demoDetail = (formId) => {
  const form = readForms().find((item) => item.id === formId);
  if (!form) throw new Error('FORM_NOT_FOUND');
  const scheme = demoSchemeRoles('scheme-standard');
  return {
    form: {
      ...form,
      requester_name: demoUser(form.requested_by).full_name,
      employee_name: form.data_json?.employee?.full_name,
      current_assignee_name: form.current_assignee_id ? demoUser(form.current_assignee_id).full_name : null,
      template_name: form.templates?.name,
      template_name_ar: form.templates?.name_ar,
      template_name_en: form.templates?.name_en,
      current_role_id: form.current_approval_role_id || null,
    },
    scheme,
    transactions: readTx()[formId] || [],
    attachments: [],
  };
};

const demoIsComplete = (formId) => {
  const transactions = readTx()[formId] || [];
  const scheme = demoSchemeRoles('scheme-standard');
  return scheme.roles
    .filter((role) => role.code !== 'REQUESTER')
    .every((role) => transactions.some((tx) => tx.action === 'Approve' && tx.role_id === role.id));
};

// ---------------------------------------------------------------------------
// Approval roles & schemes (administration)
// ---------------------------------------------------------------------------
export async function loadApprovalRoles() {
  if (useLocalData) return demoRoles;
  const { data, error } = await supabase.from('approval_roles').select('*').order('display_order');
  if (error) throw error;
  return data;
}

export async function loadApprovalSchemes() {
  if (useLocalData) return demoSchemes.map((scheme) => demoSchemeRoles(scheme.id));
  const { data, error } = await supabase
    .from('approval_schemes')
    .select('*, approval_scheme_roles(id, display_order, is_required, approval_roles(id, code, name_ar, name_en, is_active))')
    .order('code');
  if (error) throw error;
  return (data || []).map((scheme) => ({
    ...scheme,
    roles: (scheme.approval_scheme_roles || [])
      .slice()
      .sort((a, b) => a.display_order - b.display_order)
      .map((row) => ({ ...row.approval_roles, display_order: row.display_order, is_required: row.is_required })),
  }));
}

export async function saveApprovalRole(role) {
  if (useLocalData) return role;
  const payload = {
    code: role.code?.trim().toUpperCase().replaceAll(' ', '_'),
    name_ar: role.name_ar,
    name_en: role.name_en,
    description: role.description || null,
    display_order: Number(role.display_order) || 0,
    is_active: role.is_active ?? true,
  };
  if (role.id) payload.id = role.id;
  const { data, error } = await supabase.from('approval_roles').upsert(payload, { onConflict: 'code' }).select().single();
  if (error) throw error;
  return data;
}

export async function saveApprovalScheme(scheme, roleIds) {
  if (useLocalData) return scheme;
  const payload = {
    code: scheme.code?.trim().toUpperCase().replaceAll(' ', '_'),
    name_ar: scheme.name_ar,
    name_en: scheme.name_en,
    description: scheme.description || null,
    is_active: scheme.is_active ?? true,
  };
  if (scheme.id) payload.id = scheme.id;
  const { data: saved, error } = await supabase.from('approval_schemes').upsert(payload, { onConflict: 'code' }).select().single();
  if (error) throw error;
  const { error: clearError } = await supabase.from('approval_scheme_roles').delete().eq('scheme_id', saved.id);
  if (clearError) throw clearError;
  if (roleIds.length) {
    const { error: insertError } = await supabase.from('approval_scheme_roles').insert(
      roleIds.map((roleId, index) => ({ scheme_id: saved.id, approval_role_id: roleId, display_order: index + 1 }))
    );
    if (insertError) throw insertError;
  }
  return saved;
}

export async function loadTemplatesWithSchemes() {
  if (useLocalData) {
    return [
      { id: 'performance', code: 'PERFORMANCE', name: 'تقييم الأداء', approval_scheme_id: 'scheme-standard' },
      { id: 'internal-memo', code: 'INTERNAL_MEMO', name: 'مذكرة داخلية', approval_scheme_id: 'scheme-standard' },
    ];
  }
  const { data, error } = await supabase
    .from('templates')
    .select('id, code, name, name_ar, name_en, approval_scheme_id, is_active')
    .eq('is_active', true)
    .order('name');
  if (error) throw error;
  return data;
}

export async function assignSchemeToTemplate(templateId, schemeId) {
  if (useLocalData) return;
  const { error } = await supabase.from('templates').update({ approval_scheme_id: schemeId || null }).eq('id', templateId);
  if (error) throw error;
}

export async function loadSchemeForTemplate(templateId) {
  if (useLocalData) return demoSchemeRoles('scheme-standard');
  const { data, error } = await supabase
    .from('templates')
    .select('approval_scheme_id, approval_schemes(*, approval_scheme_roles(id, display_order, is_required, approval_roles(id, code, name_ar, name_en, is_active)))')
    .eq('id', templateId)
    .single();
  if (error) throw error;
  const scheme = data?.approval_schemes;
  if (!scheme) return null;
  return {
    ...scheme,
    roles: (scheme.approval_scheme_roles || [])
      .slice()
      .sort((a, b) => a.display_order - b.display_order)
      .map((row) => ({ ...row.approval_roles, display_order: row.display_order, is_required: row.is_required })),
  };
}

// ---------------------------------------------------------------------------
// Chain actions
// ---------------------------------------------------------------------------
export async function submitForApproval({ formId, roleId, toUserId, comment }) {
  if (useLocalData) {
    const form = readForms().find((item) => item.id === formId);
    if (!form) throw new Error('FORM_NOT_FOUND');
    demoAppendTx(formId, { actor_id: DEMO_USER_ID, action: 'Submit', role_id: roleId, to_user_id: toUserId, comment });
    return demoUpdateForm(formId, {
      status: 'InApproval',
      current_assignee_id: toUserId,
      current_approval_role_id: roleId,
      return_to_user_id: null,
      verify_code: form.verify_code || demoVerifyCode(),
      approval_started_on: form.approval_started_on || new Date().toISOString(),
      pending_since: new Date().toISOString(),
    });
  }
  const { data, error } = await supabase.rpc('approval_submit', {
    p_form_id: formId, p_role_id: roleId, p_to_user: toUserId, p_comment: comment || null,
  });
  if (error) throw error;
  return data;
}

export async function actOnApproval({ formId, action, toUserId, roleId, comment }) {
  if (useLocalData) {
    const form = readForms().find((item) => item.id === formId);
    if (!form) throw new Error('FORM_NOT_FOUND');
    demoAppendTx(formId, {
      actor_id: form.current_assignee_id || DEMO_USER_ID,
      action,
      role_id: action === 'Forward' ? roleId : form.current_approval_role_id,
      to_user_id: toUserId || null,
      comment,
    });
    if (action === 'Approve') {
      const completed = demoIsComplete(formId);
      return demoUpdateForm(formId, {
        status: completed ? 'Approved' : 'InApproval',
        current_assignee_id: completed ? null : form.requested_by,
        current_approval_role_id: null,
        approval_completed_on: completed ? new Date().toISOString() : null,
      });
    }
    if (action === 'Reject') {
      return demoUpdateForm(formId, { status: 'Rejected', current_assignee_id: form.requested_by, current_approval_role_id: null });
    }
    if (action === 'Reviewed') {
      return demoUpdateForm(formId, { current_assignee_id: form.return_to_user_id, return_to_user_id: null, pending_since: new Date().toISOString() });
    }
    if (action === 'RequestReview') {
      return demoUpdateForm(formId, { current_assignee_id: toUserId, return_to_user_id: form.current_assignee_id, pending_since: new Date().toISOString() });
    }
    // Delegate / Forward
    return demoUpdateForm(formId, {
      current_assignee_id: toUserId,
      current_approval_role_id: action === 'Forward' ? roleId : form.current_approval_role_id,
      pending_since: new Date().toISOString(),
    });
  }
  const { data, error } = await supabase.rpc('approval_act', {
    p_form_id: formId, p_action: action, p_to_user: toUserId || null, p_role_id: roleId || null, p_comment: comment || null,
  });
  if (error) throw error;
  return data;
}

export async function recallApproval(formId) {
  if (useLocalData) {
    const form = readForms().find((item) => item.id === formId);
    if (!form) throw new Error('FORM_NOT_FOUND');
    demoAppendTx(formId, { actor_id: form.requested_by, action: 'Recall', role_id: form.current_approval_role_id });
    return demoUpdateForm(formId, { current_assignee_id: form.requested_by, current_approval_role_id: null, return_to_user_id: null });
  }
  const { data, error } = await supabase.rpc('approval_recall', { p_form_id: formId });
  if (error) throw error;
  return data;
}

// Terminal state: a cancelled request stays visible to everyone but can never
// be edited, resent or reopened.
export async function cancelApprovalRequest({ formId, comment }) {
  if (useLocalData) {
    const form = readForms().find((item) => item.id === formId);
    if (!form) throw new Error('FORM_NOT_FOUND');
    if (form.status === 'Cancelled') throw new Error('FORM_ALREADY_CANCELLED');
    demoAppendTx(formId, { actor_id: form.requested_by, action: 'Cancel', comment });
    return demoUpdateForm(formId, {
      status: 'Cancelled',
      current_assignee_id: null,
      current_approval_role_id: null,
      return_to_user_id: null,
      verify_code: form.verify_code || demoVerifyCode(),
      cancelled_on: new Date().toISOString(),
    });
  }
  const { data, error } = await supabase.rpc('approval_cancel', { p_form_id: formId, p_comment: comment || null });
  if (error) throw error;
  return data;
}

export async function searchMyRequests(query) {
  const needle = String(query || '').trim().toLowerCase();
  if (needle.length < 2) return [];
  if (useLocalData) {
    return readForms()
      .filter((form) => `${form.reference_no || ''} ${form.verify_code || ''} ${form.templates?.name || ''}`.toLowerCase().includes(needle))
      .slice(0, 6);
  }
  const { data, error } = await supabase.rpc('approval_search_my_requests', { p_query: needle });
  if (error) throw error;
  return data || [];
}

export async function reassignApproval({ formId, toUserId, comment }) {
  if (useLocalData) {
    demoAppendTx(formId, { actor_id: DEMO_USER_ID, action: 'Reassign', to_user_id: toUserId, comment });
    return demoUpdateForm(formId, { current_assignee_id: toUserId, return_to_user_id: null, pending_since: new Date().toISOString() });
  }
  const { data, error } = await supabase.rpc('approval_admin_reassign', {
    p_form_id: formId, p_to_user: toUserId, p_comment: comment || null,
  });
  if (error) throw error;
  return data;
}

// ---------------------------------------------------------------------------
// Read models
// ---------------------------------------------------------------------------
export async function loadApprovalCenterFeed(userId) {
  if (useLocalData) {
    const forms = readForms();
    const txMap = readTx();
    const enrich = (form) => ({
      id: form.id,
      reference_no: form.reference_no,
      verify_code: form.verify_code,
      status: form.status,
      template_id: form.template_id,
      template_name: form.templates?.name,
      template_name_ar: form.templates?.name_ar,
      template_name_en: form.templates?.name_en,
      requester_name: demoUser(form.requested_by).full_name,
      assignee_id: form.current_assignee_id,
      assignee_name: form.current_assignee_id ? demoUser(form.current_assignee_id).full_name : null,
      role_name_ar: demoRole(form.current_approval_role_id)?.name_ar,
      role_name_en: demoRole(form.current_approval_role_id)?.name_en,
      is_review: !!form.return_to_user_id,
      is_own_return: form.requested_by === userId,
      pending_since: form.pending_since,
      approval_started_on: form.approval_started_on,
      approval_completed_on: form.approval_completed_on,
      updated_on: form.updated_on,
      held_by_me: form.status !== 'Cancelled' && (form.current_assignee_id || form.requested_by) === userId,
      can_recall: form.status === 'InApproval' && form.current_assignee_id !== userId
        && (txMap[form.id] || []).slice(-1)[0]?.action === 'Submit',
      last_action: (txMap[form.id] || []).slice(-1)[0]?.action,
      last_actor_name: (txMap[form.id] || []).slice(-1)[0]?.actor_name,
      last_comment: (txMap[form.id] || []).slice(-1)[0]?.comment,
    });
    return {
      inbox: forms.filter((form) => form.current_assignee_id === userId && form.status === 'InApproval').map(enrich),
      outbox: forms.filter((form) => form.requested_by === userId && form.approval_started_on).map(enrich),
      history: forms.filter((form) => form.approval_started_on).map(enrich),
    };
  }
  const { data, error } = await supabase.rpc('approval_center_feed');
  if (error) throw error;
  return data;
}

// Compact feed for the home dashboard card.
export async function loadPendingApprovals(userId, limit = 3) {
  const feed = await loadApprovalCenterFeed(userId);
  const inbox = feed.inbox || [];
  return {
    count: inbox.length,
    items: inbox.slice(0, limit),
    lateCount: inbox.filter((item) => (
      item.pending_since && (Date.now() - new Date(item.pending_since).getTime()) / 36e5 > 48
    )).length,
  };
}

export async function loadApprovalFormDetail(formId) {
  if (useLocalData) return demoDetail(formId);
  const { data, error } = await supabase.rpc('approval_form_detail', { p_form_id: formId });
  if (error) throw error;
  return data;
}

export async function loadApprovalDashboard() {
  if (useLocalData) {
    const forms = readForms();
    const txMap = readTx();
    return {
      pending: forms.filter((form) => form.status === 'InApproval').map((form) => ({
        id: form.id,
        reference_no: form.reference_no,
        template_name: form.templates?.name,
        requester_name: demoUser(form.requested_by).full_name,
        assignee_id: form.current_assignee_id,
        assignee_name: demoUser(form.current_assignee_id).full_name,
        assignee_department: demoUser(form.current_assignee_id).department,
        role_name_ar: demoRole(form.current_approval_role_id)?.name_ar,
        pending_since: form.pending_since,
        approval_started_on: form.approval_started_on,
      })),
      completed: forms.filter((form) => ['Approved', 'Rejected'].includes(form.status)).map((form) => ({
        id: form.id, status: form.status,
        approval_started_on: form.approval_started_on,
        approval_completed_on: form.approval_completed_on,
        updated_on: form.updated_on,
      })),
      transactions: Object.values(txMap).flat().map((tx) => ({
        action: tx.action, actor_id: tx.actor_id, actor_name: tx.actor_name,
        department: demoUser(tx.actor_id).department, created_on: tx.created_on,
      })),
    };
  }
  const { data, error } = await supabase.rpc('approval_dashboard_data');
  if (error) throw error;
  return data;
}

export async function verifyApprovalCode(code) {
  if (useLocalData) {
    const form = readForms().find((item) => item.verify_code === String(code).trim());
    if (!form) return { valid: false };
    return {
      valid: true,
      reference_no: form.reference_no,
      verify_code: form.verify_code,
      status: form.status,
      template_name: form.templates?.name,
      requester_name: demoUser(form.requested_by).full_name,
      employee_name: form.data_json?.employee?.full_name,
      submitted_on: form.submitted_on,
      approval_started_on: form.approval_started_on,
      approval_completed_on: form.approval_completed_on,
      timeline: readTx()[form.id] || [],
    };
  }
  const { data, error } = await supabase.rpc('approval_verify', { p_code: String(code).trim() });
  if (error) throw error;
  return data;
}

export async function loadRecipients() {
  if (useLocalData) return demoDirectory;
  const { data, error } = await supabase.rpc('list_form_recipients');
  if (error) throw error;
  return data || [];
}

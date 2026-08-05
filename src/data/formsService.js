import { supabase, useLocalData } from '../lib/supabaseClient';

const storageKey = 'bbnovix_forms_demo';

const defaultTemplates = [
  { id: 'performance', code: 'PERFORMANCE', name: 'Performance Evaluation', category: 'HR', description: 'Annual objectives and competencies review.' },
  { id: 'leave', code: 'LEAVE_REQUEST', name: 'Leave Request', category: 'HR', description: 'Submit and track vacation or emergency leave.' },
  { id: 'training', code: 'TRAINING_REQUEST', name: 'Training Request', category: 'HR', description: 'Request professional training or certification.' },
  { id: 'business_trip', code: 'BUSINESS_TRIP', name: 'Business Trip', category: 'Operations', description: 'Create a travel and mission request.' },
  { id: 'certificate', code: 'CERTIFICATE_REQUEST', name: 'Certificate Request', category: 'HR', description: 'Request salary, employment, or experience letters.' },
];

const defaultGoals = [
  { id: 'goal-sla', code: 'OPS-001', category: 'تشغيلي', goal: 'رفع الالتزام بمستوى الخدمة', measurement: 'نسبة الالتزام SLA', default_weight: 25 },
  { id: 'goal-cost', code: 'FIN-001', category: 'مالي', goal: 'خفض تكلفة التشغيل', measurement: 'نسبة الخفض المحققة', default_weight: 20 },
  { id: 'goal-safety', code: 'SAF-001', category: 'السلامة', goal: 'تحسين الامتثال للسلامة', measurement: 'نسبة الامتثال', default_weight: 25 },
  { id: 'goal-quality', code: 'QUA-001', category: 'الجودة', goal: 'رفع جودة الخدمة', measurement: 'نتيجة تدقيق الجودة', default_weight: 20 },
];

const defaultCompetencies = [
  { id: 'comp-communication', code: 'CORE-001', category: 'أساسية', parent: 'التواصل', name: 'التواصل الفعال', description: 'نقل واستقبال المعلومات بوضوح واحترافية.', default_weight: 10 },
  { id: 'comp-teamwork', code: 'CORE-002', category: 'أساسية', parent: 'التعاون', name: 'العمل الجماعي', description: 'التعاون مع الآخرين لتحقيق أهداف مشتركة.', default_weight: 10 },
  { id: 'comp-service', code: 'CORE-003', category: 'أساسية', parent: 'خدمة المستفيد', name: 'خدمة العملاء الداخليين', description: 'تقديم خدمة عالية الجودة للإدارات والزملاء.', default_weight: 10 },
  { id: 'comp-accounting', code: 'FIN-001', category: 'وظيفية', parent: 'المالية', name: 'المحاسبة المالية', description: 'تسجيل وتصنيف وتلخيص العمليات وفق المعايير المعتمدة.', default_weight: 10 },
  { id: 'comp-reconciliation', code: 'FIN-004', category: 'وظيفية', parent: 'المالية', name: 'التسويات البنكية', description: 'إجراء التسويات وتحليل الفروقات بدقة.', default_weight: 10 },
];

const defaultEmployees = [
  {
    id: 'demo-user',
    employee_no: '10001',
    full_name: 'أحمد محمد',
    name_ar: 'أحمد محمد',
    name_en: 'Ahmed Mohammed',
    department: 'الموارد البشرية',
    job_title: 'مدير النظام',
    nationality: 'سعودي',
    gender: 'ذكر',
    national_id: '10XXXXXXXX',
    project: 'المقر الرئيسي',
    sector: 'الخدمات المشتركة',
    site: 'الرياض',
  },
  {
    id: 'demo-employee-2',
    employee_no: '10024',
    full_name: 'سارة خالد',
    name_ar: 'سارة خالد',
    name_en: 'Sara Khalid',
    department: 'المالية',
    job_title: 'محاسب أول',
    nationality: 'سعودية',
    gender: 'أنثى',
    project: 'المقر الرئيسي',
    sector: 'الخدمات المشتركة',
    site: 'الرياض',
  },
];

const readDemoForms = () => JSON.parse(localStorage.getItem(storageKey) || '[]');
const writeDemoForms = (forms) => localStorage.setItem(storageKey, JSON.stringify(forms));

export const calculatePerformance = (goals, competencies) => {
  const objectiveScore = goals.reduce((sum, row) => sum + Number(row.weighted || 0), 0);
  const competencyScore = competencies.reduce((sum, row) => sum + Number(row.weighted || 0), 0);
  const overallScore = Number(((objectiveScore * 0.6) + (competencyScore * 0.4)).toFixed(2));
  const overallRate =
    overallScore >= 4.5 ? 'Outstanding' :
    overallScore >= 3.75 ? 'Exceeds Expectations' :
    overallScore >= 3 ? 'Meets Expectations' :
    overallScore >= 2 ? 'Needs Improvement' :
    'Unsatisfactory';

  return { overallScore, overallRate };
};

export async function loadFormWorkspace(userId) {
  if (useLocalData) {
    return {
      templates: defaultTemplates,
      goals: defaultGoals,
      competencies: defaultCompetencies,
      cycles: [],
      forms: readDemoForms(),
      employees: defaultEmployees,
    };
  }

  const [templates, goals, competencies, cycles, employeeDirectory] = await Promise.all([
    supabase.from('templates').select('*').eq('is_active', true).order('name'),
    supabase.from('goals').select('*').eq('is_active', true).order('category'),
    supabase.from('competencies').select('*').eq('is_active', true).order('category'),
    supabase.from('evaluation_cycles').select('*').eq('is_active', true).eq('is_deleted', false).order('start_date', { ascending: false }),
    supabase.rpc('list_form_recipients'),
  ]);

  let forms = await supabase
    .from('forms')
    .select('*, templates(name, code), performance_evaluations(*)')
    .eq('requested_by', userId)
    .order('updated_on', { ascending: false });
  if (forms.error?.code === '42703') {
    forms = await supabase
      .from('forms')
      .select('*, templates(name, code), performance_evaluations(*)')
      .eq('employee_id', userId)
      .order('updated_on', { ascending: false });
  }

  const failed = [templates, goals, competencies, cycles, forms, employeeDirectory].find((result) => result.error);
  if (failed) throw failed.error;

  return {
    templates: templates.data,
    goals: goals.data,
    competencies: competencies.data,
    cycles: cycles.data,
    forms: forms.data,
    employees: employeeDirectory.data,
  };
}

export async function savePerformanceEvaluation({ profile, template, status, form, selectedGoals, selectedCompetencies }) {
  const calculated = calculatePerformance(selectedGoals, selectedCompetencies);
  const overallScore = Number(form.overall_score ?? calculated.overallScore);
  const overallRate = form.overall_rate || calculated.overallRate;
  const now = new Date().toISOString();
  const dataJson = {
    reference: form.reference,
    cycle_id: form.cycle_id,
    cycle_name: form.cycle_name,
    evaluation_type: form.evaluation_type,
    submission_mode: form.submission_mode,
    employee: form.employee,
    start_date: form.start_date,
    end_date: form.end_date,
    evaluation_date: form.evaluation_date,
    evaluator_name: form.evaluator_name,
    evaluator_signature_url: form.evaluator_signature_url,
    reviewer_name: form.reviewer_name,
    director_name: form.director_name,
    objectives_weight: form.objectives_weight,
    competencies_weight: form.competencies_weight,
    overall_comment: form.overall_comment,
    overall_score: overallScore,
    overall_rate: overallRate,
    goals: selectedGoals,
    competencies: selectedCompetencies,
  };

  if (useLocalData) {
    const existing = readDemoForms();
    const formId = form?.id || crypto.randomUUID();
    const nextForm = {
      id: formId,
      template_id: template.id,
      employee_id: form.employee.id,
      requested_by: profile.id,
      submission_mode: form.submission_mode,
      status,
      reference_no: form.reference,
      data_json: dataJson,
      templates: template,
      performance_evaluations: [{ overall_score: overallScore, overall_rate: overallRate, period: form.cycle_name, manager: form.evaluator_name }],
      created_on: form?.created_on || now,
      updated_on: now,
      submitted_on: status === 'Submitted' ? now : null,
    };
    writeDemoForms([nextForm, ...existing.filter((item) => item.id !== formId)]);
    return nextForm;
  }

  const formPayload = {
    template_id: template.id,
    employee_id: form.employee.id,
    requested_by: profile.id,
    submission_mode: form.submission_mode,
    status,
    reference_no: form.reference,
    data_json: dataJson,
    submitted_on: status === 'Submitted' ? now : form?.submitted_on || null,
    updated_on: now,
  };
  if (form?.id) formPayload.id = form.id;

  const { data: savedForm, error: formError } = await supabase
    .from('forms')
    .upsert(formPayload)
    .select()
    .single();

  if (formError) throw formError;

  const { data: evaluation, error: evaluationError } = await supabase
    .from('performance_evaluations')
    .upsert({
      form_id: savedForm.id,
      period: form.cycle_name || 'Independent Evaluation',
      manager: form.evaluator_name,
      employee_id: form.employee.id,
      evaluation_cycle_id: form.cycle_id || null,
      objectives_weight: form.objectives_weight,
      competencies_weight: form.competencies_weight,
      objectives_score: selectedGoals.reduce((sum, row) => sum + Number(row.weighted || 0), 0),
      competencies_score: selectedCompetencies.reduce((sum, row) => sum + Number(row.weighted || 0), 0),
      workflow_status: status,
      overall_score: overallScore,
      overall_rate: overallRate,
      employee_comment: form.overall_comment,
    }, { onConflict: 'form_id' })
    .select()
    .single();

  if (evaluationError) throw evaluationError;

  await supabase.from('evaluation_goals').delete().eq('evaluation_id', evaluation.id);
  await supabase.from('evaluation_competencies').delete().eq('evaluation_id', evaluation.id);

  if (selectedGoals.length) {
    const { error } = await supabase.from('evaluation_goals').insert(
      selectedGoals.map((row) => ({
        evaluation_id: evaluation.id,
        goal_id: row.goal_id,
        weight: row.relativeWeight,
        score: row.score,
        comments: row.comments,
      }))
    );
    if (error) throw error;
  }

  if (selectedCompetencies.length) {
    const { error } = await supabase.from('evaluation_competencies').insert(
      selectedCompetencies.map((row) => ({
        evaluation_id: evaluation.id,
        competency_id: row.competency_id,
        weight: row.relativeWeight,
        score: row.score,
        comments: row.comments,
      }))
    );
    if (error) throw error;
  }

  return savedForm;
}

export async function saveInternalMemo({ profile, template, status, memo }) {
  const now = new Date().toISOString();
  const formId = memo.id || crypto.randomUUID();
  const dataJson = {
    form_type: 'INTERNAL_MEMO',
    reference: memo.reference,
    submission_mode: memo.submission_mode,
    employee: memo.employee,
    memo_title: memo.memo_title,
    memo_date: memo.memo_date,
    memo_number: memo.memo_number,
    from: memo.from,
    to: memo.to,
    cc: memo.cc,
    subject: memo.subject,
    request: memo.request,
    justification: memo.justification,
    recommendation: memo.recommendation,
    requester_name: memo.requester_name,
    requester_signature_url: memo.requester_signature_url,
    recommended_by: memo.recommended_by,
    approved_by: memo.approved_by,
    attachments: (memo.attachments || []).map((file) => ({
      name: file.name,
      size: file.size,
      type: file.type,
    })),
  };

  if (useLocalData) {
    const existing = readDemoForms();
    const next = {
      id: formId,
      template_id: template.id,
      employee_id: memo.employee.id,
      requested_by: profile.id,
      status,
      reference_no: memo.reference,
      data_json: dataJson,
      templates: template,
      created_on: memo.created_on || now,
      updated_on: now,
      submitted_on: status === 'Submitted' ? now : null,
    };
    writeDemoForms([next, ...existing.filter((item) => item.id !== formId)]);
    return next;
  }

  const payload = {
    template_id: template.id,
    employee_id: memo.employee.id,
    requested_by: profile.id,
    submission_mode: memo.submission_mode,
    status,
    reference_no: memo.reference,
    data_json: dataJson,
    submitted_on: status === 'Submitted' ? now : memo.submitted_on || null,
    updated_on: now,
  };
  if (memo.id) payload.id = memo.id;
  const { data: saved, error } = await supabase.from('forms').upsert(payload).select().single();
  if (error) throw error;

  for (const file of memo.attachments || []) {
    if (!(file instanceof File)) continue;
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const storagePath = `${profile.id}/${saved.id}/${crypto.randomUUID()}-${safeName}`;
    const { error: uploadError } = await supabase.storage.from('form-attachments').upload(storagePath, file, {
      contentType: file.type || 'application/octet-stream',
    });
    if (uploadError) throw uploadError;
    const { error: attachmentError } = await supabase.from('form_attachments').insert({
      form_id: saved.id,
      file_name: file.name,
      storage_path: storagePath,
      mime_type: file.type || null,
      file_size: file.size,
      uploaded_by: profile.id,
    });
    if (attachmentError) throw attachmentError;
  }
  return saved;
}

export async function deleteDraftForm(formId) {
  if (useLocalData) {
    writeDemoForms(readDemoForms().filter((item) => item.id !== formId));
    return;
  }

  const { error } = await supabase.from('forms').delete().eq('id', formId).eq('status', 'Draft');
  if (error) throw error;
}

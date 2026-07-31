insert into public.templates (code, name, category, description, version, is_active)
values
  ('PERFORMANCE', 'Performance Evaluation', 'HR', 'Annual objectives and competencies review.', 1, true),
  ('LEAVE_REQUEST', 'Leave Request', 'HR', 'Vacation, emergency, or unpaid leave request.', 1, true),
  ('TRAINING_REQUEST', 'Training Request', 'HR', 'Training course or certification request.', 1, true),
  ('BUSINESS_TRIP', 'Business Trip', 'Operations', 'Business travel and mission approval request.', 1, true),
  ('CERTIFICATE_REQUEST', 'Certificate Request', 'HR', 'Employment, salary, or experience certificate request.', 1, true)
on conflict (code) do update set
  name = excluded.name,
  category = excluded.category,
  description = excluded.description,
  version = excluded.version,
  is_active = excluded.is_active;

insert into public.competencies (category, name, description, default_weight, is_active)
values
  ('Core', 'Leadership', 'Guides people and decisions with accountability.', 25, true),
  ('Core', 'Teamwork', 'Collaborates respectfully and supports shared outcomes.', 25, true),
  ('Core', 'Planning', 'Organizes work, priorities, and deadlines effectively.', 25, true),
  ('Core', 'Innovation', 'Improves methods and proposes practical solutions.', 25, true)
on conflict do nothing;

insert into public.goals (category, goal, default_weight, is_active)
values
  ('Financial', 'Increase Revenue', 30, true),
  ('Operational', 'Reduce Operating Cost', 20, true),
  ('Customer', 'Improve Service Level Compliance', 25, true),
  ('Safety', 'Improve Safety Compliance', 25, true)
on conflict do nothing;

insert into public.permissions (code, module, description)
values
  ('Dashboard.View', 'Dashboard', 'View employee dashboard'),
  ('Forms.View', 'Forms', 'View forms'),
  ('Forms.Create', 'Forms', 'Create forms'),
  ('Forms.Update', 'Forms', 'Update permitted forms'),
  ('Forms.Delete', 'Forms', 'Delete draft forms'),
  ('Forms.Approve', 'Forms', 'Approve workflow items'),
  ('Forms.Publish', 'Forms', 'Publish form templates'),
  ('Employees.Manage', 'Administration', 'Manage employee identities and invitations'),
  ('Roles.View', 'Administration', 'View roles and permissions'),
  ('Roles.Manage', 'Administration', 'Manage roles and permission sets'),
  ('Roles.Assign', 'Administration', 'Assign roles to users'),
  ('Goals.Manage', 'Performance', 'Manage goal library'),
  ('Competencies.Manage', 'Performance', 'Manage competency library'),
  ('Performance.Cycles.Manage', 'Performance', 'Manage evaluation cycles'),
  ('Performance.Templates.Manage', 'Performance', 'Manage evaluation templates'),
  ('Performance.Analytics.View', 'Performance', 'View enterprise performance analytics'),
  ('Content.Manage', 'Content', 'Manage documents, circulars, and designs'),
  ('Audit.View', 'Security', 'View audit trail'),
  ('Profile.Update', 'Profile', 'Update own profile')
on conflict (code) do update set
  module = excluded.module,
  description = excluded.description;

insert into public.roles (code, name_ar, name_en, description, is_system)
values
  ('PLATFORM_ADMIN', 'مسؤول المنصة', 'Platform Administrator', 'Full platform ownership and governance.', true),
  ('SYSTEM_ADMIN', 'مسؤول النظام', 'System Administrator', 'System, employee, content, and performance administration.', true),
  ('DEPARTMENT_MANAGER', 'مدير الإدارة', 'Department Manager', 'Department workflow and performance management.', true),
  ('DEPARTMENT_COORDINATOR', 'منسق الإدارة', 'Department Coordinator', 'Department request and content coordination.', true),
  ('EMPLOYEE', 'موظف', 'Employee', 'Employee self-service access.', true)
on conflict (code) do update set
  name_ar = excluded.name_ar,
  name_en = excluded.name_en,
  description = excluded.description,
  is_system = excluded.is_system;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r cross join public.permissions p
where r.code = 'PLATFORM_ADMIN'
on conflict do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r cross join public.permissions p
where r.code = 'SYSTEM_ADMIN' and p.code <> 'Roles.Manage'
on conflict do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on p.code in ('Dashboard.View','Forms.View','Forms.Create','Forms.Update','Forms.Approve','Performance.Analytics.View','Profile.Update')
where r.code = 'DEPARTMENT_MANAGER'
on conflict do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on p.code in ('Dashboard.View','Forms.View','Forms.Create','Forms.Update','Profile.Update')
where r.code in ('DEPARTMENT_COORDINATOR','EMPLOYEE')
on conflict do nothing;

insert into public.proficiency_levels(level_no, name_ar, name_en, description_ar, description_en)
values
  (1, 'مبتدئ', 'Beginner', 'يحتاج توجيهاً مباشراً ومتابعة مستمرة.', 'Requires direct guidance and continuous follow-up.'),
  (2, 'أساسي', 'Basic', 'يطبق الأساسيات في المواقف المعتادة.', 'Applies fundamentals in routine situations.'),
  (3, 'متمكن', 'Proficient', 'ينفذ باستقلالية وبجودة ثابتة.', 'Works independently with consistent quality.'),
  (4, 'متقدم', 'Advanced', 'يتعامل مع الحالات المعقدة ويدعم الآخرين.', 'Handles complex situations and supports others.'),
  (5, 'خبير', 'Expert', 'مرجع معرفي يطور الممارسة والمعايير.', 'A subject reference who advances practice and standards.')
on conflict (level_no) do update set
  name_ar = excluded.name_ar,
  name_en = excluded.name_en,
  description_ar = excluded.description_ar,
  description_en = excluded.description_en;

update public.competencies set
  code = case name
    when 'Leadership' then 'CORE-004'
    when 'Teamwork' then 'CORE-002'
    when 'Planning' then 'CORE-005'
    when 'Innovation' then 'CORE-006'
  end,
  definition = description,
  applicable_departments = '["ALL"]'::jsonb,
  applicable_jobs = '["ALL"]'::jsonb
where name in ('Leadership','Teamwork','Planning','Innovation');

insert into public.competencies(code, category, name, description, definition, default_weight, applicable_departments, applicable_jobs)
select 'CORE-001', 'Core', 'Effective Communication', 'Clear and professional exchange of information.', 'The ability to send and receive information clearly and professionally.', 10, '["ALL"]', '["ALL"]'
where not exists (select 1 from public.competencies where code = 'CORE-001' and not is_deleted);

insert into public.competencies(code, category, name, description, definition, default_weight, applicable_departments, applicable_jobs)
select 'CORE-003', 'Core', 'Internal Customer Service', 'High-quality service to departments and colleagues.', 'The ability to understand internal needs, respond, follow up, and measure satisfaction.', 10, '["ALL"]', '["ALL"]'
where not exists (select 1 from public.competencies where code = 'CORE-003' and not is_deleted);

insert into public.competencies(code, category, name, description, definition, default_weight, applicable_departments, applicable_jobs)
select 'FIN-001', 'Finance', 'Financial Accounting', 'Accurate accounting in line with approved standards.', 'Record, classify, and summarize financial transactions according to approved accounting standards.', 10, '["FINANCE"]', '["ACCOUNTANT","SENIOR_ACCOUNTANT","CHIEF_ACCOUNTANT"]'
where not exists (select 1 from public.competencies where code = 'FIN-001' and not is_deleted);

insert into public.competencies(code, category, name, description, definition, default_weight, applicable_departments, applicable_jobs)
select 'FIN-004', 'Finance', 'Bank Reconciliation', 'Accurate reconciliation and variance analysis.', 'Perform bank reconciliations and analyze differences accurately.', 10, '["FINANCE"]', '["ACCOUNTANT","TREASURER"]'
where not exists (select 1 from public.competencies where code = 'FIN-004' and not is_deleted);

update public.goals set
  code = case goal
    when 'Increase Revenue' then 'FIN-REV-001'
    when 'Reduce Operating Cost' then 'FIN-COST-001'
    when 'Improve Service Level Compliance' then 'OPS-SLA-001'
    when 'Improve Safety Compliance' then 'SAF-COMP-001'
  end,
  title = goal,
  measurement = case goal
    when 'Increase Revenue' then 'Revenue growth percentage'
    when 'Reduce Operating Cost' then 'Cost reduction percentage'
    when 'Improve Service Level Compliance' then 'SLA compliance percentage'
    when 'Improve Safety Compliance' then 'Safety compliance percentage'
  end,
  formula = 'Actual / Target * 100',
  applicable_departments = '["ALL"]'::jsonb,
  applicable_jobs = '["ALL"]'::jsonb
where goal in ('Increase Revenue','Reduce Operating Cost','Improve Service Level Compliance','Improve Safety Compliance');

insert into public.evaluation_templates(code, name_ar, name_en, description, version, objectives_weight, competencies_weight, allow_custom_goals)
values ('STANDARD-PERFORMANCE', 'نموذج تقييم الأداء القياسي', 'Standard Performance Evaluation', 'Objectives, competencies, comments, and approval workflow.', 1, 60, 40, false)
on conflict (code, version) do update set
  name_ar = excluded.name_ar,
  name_en = excluded.name_en,
  description = excluded.description,
  objectives_weight = excluded.objectives_weight,
  competencies_weight = excluded.competencies_weight;

insert into public.evaluation_sections(evaluation_template_id, section_code, title_ar, title_en, section_type, display_order)
select t.id, s.section_code, s.title_ar, s.title_en, s.section_type, s.display_order
from public.evaluation_templates t
cross join (values
  ('EMPLOYEE_INFO', 'بيانات الموظف وفترة التقييم', 'Employee data and evaluation period', 'EmployeeInfo', 1),
  ('OBJECTIVES', 'تقييم الأهداف', 'Evaluate objectives', 'Objectives', 2),
  ('COMPETENCIES', 'تقييم الجدارات', 'Evaluation of competencies', 'Competencies', 3),
  ('COMMENTS', 'الملاحظات العامة', 'Overall comments', 'Comments', 4),
  ('WORKFLOW', 'مسار الاعتماد', 'Approval workflow', 'Workflow', 5)
) as s(section_code, title_ar, title_en, section_type, display_order)
where t.code = 'STANDARD-PERFORMANCE' and t.version = 1
on conflict (evaluation_template_id, section_code) do update set
  title_ar = excluded.title_ar,
  title_en = excluded.title_en,
  section_type = excluded.section_type,
  display_order = excluded.display_order;

insert into public.evaluation_cycles(code, name_ar, name_en, description, start_date, end_date, status, allow_self_evaluation, allow_manager_evaluation, is_active)
values
  ('APR-2026', 'التقييم السنوي 2026', 'Annual Performance Review 2026', 'Company-wide annual performance review.', '2026-01-01', '2026-12-31', 'Active', true, true, true),
  ('PROB-2026', 'تقييم فترة التجربة 2026', 'Probation Review 2026', 'Review for employees completing probation.', '2026-01-01', '2026-12-31', 'Active', true, true, true)
on conflict (code) do update set
  name_ar = excluded.name_ar,
  name_en = excluded.name_en,
  description = excluded.description,
  start_date = excluded.start_date,
  end_date = excluded.end_date,
  status = excluded.status,
  is_active = excluded.is_active;

insert into public.permissions (code, module, description)
values
  ('Settings.Manage', 'Administration', 'Manage system settings and bilingual lookup values'),
  ('Email.Manage', 'Administration', 'Manage email templates and inspect delivery queue')
on conflict (code) do update set
  module = excluded.module,
  description = excluded.description;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'PLATFORM_ADMIN'
on conflict do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on p.code in ('Settings.Manage', 'Email.Manage')
where r.code = 'SYSTEM_ADMIN'
on conflict do nothing;

insert into public.system_settings (
  setting_key, value_json, name_ar, name_en, description_ar, description_en, is_public
)
values
  (
    'performance.allow_custom_goals',
    'false'::jsonb,
    'السماح بالأهداف المخصصة',
    'Allow custom goals',
    'يسمح بإضافة هدف غير موجود في مكتبة الشركة داخل التقييم.',
    'Allows evaluators to add a goal that is not in the company library.',
    true
  ),
  (
    'performance.allow_custom_competencies',
    'false'::jsonb,
    'السماح بالجدارات المخصصة',
    'Allow custom competencies',
    'يسمح بإضافة جدارة غير موجودة في مكتبة الشركة داخل التقييم.',
    'Allows evaluators to add a competency that is not in the company library.',
    true
  ),
  (
    'localization.supported_languages',
    '["ar","en"]'::jsonb,
    'اللغات المدعومة',
    'Supported languages',
    'لغات واجهة المنصة ومحتواها.',
    'Languages supported by the platform interface and content.',
    true
  )
on conflict (setting_key) do update set
  value_json = excluded.value_json,
  name_ar = excluded.name_ar,
  name_en = excluded.name_en,
  description_ar = excluded.description_ar,
  description_en = excluded.description_en,
  is_public = excluded.is_public;

insert into public.email_templates (
  code, version, subject_ar, subject_en, body_html_ar, body_html_en
)
values
  (
    'INVITATION',
    1,
    'دعوة للانضمام إلى منصة ShalfaGate',
    'Your invitation to ShalfaGate',
    '<h1>مرحباً {{name}}</h1><p>تم إنشاء حسابك في منصة ShalfaGate. استخدم زر الدعوة الآمن لتعيين كلمة مرور المنصة.</p>',
    '<h1>Welcome {{name}}</h1><p>Your ShalfaGate account has been created. Use the secure invitation button to set your platform password.</p>'
  ),
  (
    'PASSWORD_RESET',
    1,
    'إعادة تعيين كلمة مرور ShalfaGate',
    'Reset your ShalfaGate password',
    '<h1>إعادة تعيين كلمة المرور</h1><p>استخدم الرابط الآمن لتعيين كلمة مرور جديدة لحسابك.</p>',
    '<h1>Reset your password</h1><p>Use the secure link to set a new password for your account.</p>'
  ),
  (
    'WELCOME',
    1,
    'مرحباً بك في ShalfaGate',
    'Welcome to ShalfaGate',
    '<h1>مرحباً {{name}}</h1><p>أصبح حسابك جاهزاً للاستخدام.</p>',
    '<h1>Welcome {{name}}</h1><p>Your account is ready to use.</p>'
  ),
  (
    'APPROVAL',
    1,
    'تم اعتماد الطلب {{reference_no}}',
    'Request {{reference_no}} approved',
    '<p>تم اعتماد طلبك رقم {{reference_no}}.</p>',
    '<p>Your request {{reference_no}} has been approved.</p>'
  ),
  (
    'REJECTION',
    1,
    'تحديث حالة الطلب {{reference_no}}',
    'Request {{reference_no}} status update',
    '<p>تمت إعادة الطلب رقم {{reference_no}}. راجع الملاحظات داخل المنصة.</p>',
    '<p>Request {{reference_no}} was returned. Review the comments in the platform.</p>'
  ),
  (
    'NOTIFICATION',
    1,
    'إشعار جديد من ShalfaGate',
    'New ShalfaGate notification',
    '<p>{{message}}</p>',
    '<p>{{message}}</p>'
  ),
  (
    'REMINDER',
    1,
    'تذكير من ShalfaGate',
    'ShalfaGate reminder',
    '<p>{{message}}</p>',
    '<p>{{message}}</p>'
  )
on conflict (code, version) do update set
  subject_ar = excluded.subject_ar,
  subject_en = excluded.subject_en,
  body_html_ar = excluded.body_html_ar,
  body_html_en = excluded.body_html_en,
  is_active = true;

update public.proficiency_levels
set code = 'LEVEL-' || level_no::text,
    display_order = level_no;

update public.competencies
set
  name_ar = case code
    when 'CORE-001' then 'التواصل الفعال'
    when 'CORE-002' then 'العمل الجماعي'
    when 'CORE-003' then 'خدمة العملاء الداخليين'
    when 'CORE-004' then 'القيادة'
    when 'CORE-005' then 'التخطيط'
    when 'CORE-006' then 'الابتكار'
    when 'FIN-001' then 'المحاسبة المالية'
    when 'FIN-004' then 'التسويات البنكية'
    else coalesce(name_ar, name)
  end,
  name_en = coalesce(name_en, name),
  definition_ar = case code
    when 'CORE-001' then 'القدرة على نقل واستقبال المعلومات بوضوح واحترافية.'
    when 'CORE-002' then 'التعاون مع الآخرين لتحقيق أهداف مشتركة.'
    when 'CORE-003' then 'تقديم خدمة عالية الجودة للإدارات والزملاء.'
    when 'FIN-001' then 'القدرة على تسجيل وتصنيف وتلخيص العمليات المالية وفق المعايير المحاسبية المعتمدة.'
    when 'FIN-004' then 'إجراء التسويات البنكية وتحليل الفروقات بدقة.'
    else coalesce(definition_ar, description)
  end,
  definition_en = coalesce(definition_en, definition, description)
where code is not null;

insert into public.competency_indicators (
  competency_id, indicator_order, text_ar, text_en
)
select c.id, i.indicator_order, i.text_ar, i.text_en
from public.competencies c
join (
  values
    ('CORE-001', 1, 'يعبر عن أفكاره بوضوح.', 'Expresses ideas clearly.'),
    ('CORE-001', 2, 'ينصت باهتمام.', 'Listens attentively.'),
    ('CORE-001', 3, 'يكتب رسائل مهنية.', 'Writes professional messages.'),
    ('CORE-001', 4, 'يكيف أسلوبه حسب الجمهور.', 'Adapts communication to the audience.'),
    ('CORE-001', 5, 'يتابع حتى إغلاق الموضوع.', 'Follows through until closure.'),
    ('CORE-002', 1, 'يشارك المعرفة.', 'Shares knowledge.'),
    ('CORE-002', 2, 'يدعم الفريق.', 'Supports the team.'),
    ('CORE-002', 3, 'يحترم الآراء.', 'Respects different views.'),
    ('CORE-002', 4, 'يحل الخلافات بإيجابية.', 'Resolves disagreements constructively.'),
    ('CORE-002', 5, 'يساهم في النجاح الجماعي.', 'Contributes to shared success.')
) as i(code, indicator_order, text_ar, text_en)
  on i.code = c.code
where not c.is_deleted
on conflict (competency_id, indicator_order) where not is_deleted
do update set
  text_ar = excluded.text_ar,
  text_en = excluded.text_en,
  is_active = true;

insert into public.goals (
  code, category, goal, title, title_ar, title_en, description_ar, description_en,
  measurement, measurement_unit_ar, measurement_unit_en, measurement_formula,
  target_formula, frequency, applicable_departments, applicable_jobs,
  default_weight, is_active
)
values
  (
    'FIN-OP-001',
    'Finance Operations',
    'Process received invoices within target time',
    'Process received invoices within target time',
    'معالجة الفواتير المستلمة ضمن الزمن المستهدف',
    'Process received invoices within target time',
    'معالجة واعتماد الفواتير المستلمة وفق الإجراءات والسياسات المالية المعتمدة خلال الفترة الزمنية المحددة.',
    'Process and approve received invoices under approved finance procedures and policies within the specified timeframe.',
    'SLA compliance percentage',
    'نسبة الفواتير المعالجة ضمن اتفاقية مستوى الخدمة',
    'Invoices processed within SLA',
    '(invoices_processed_within_sla / total_invoices) * 100',
    '>= 95',
    'Monthly',
    '["FINANCE","ACCOUNTS_PAYABLE"]'::jsonb,
    '["ACCOUNTANT","SENIOR_ACCOUNTANT","AP_SPECIALIST"]'::jsonb,
    20,
    true
  ),
  (
    'FIN-OP-002',
    'Finance Operations',
    'Improve journal entry accuracy',
    'Improve journal entry accuracy',
    'رفع دقة تسجيل القيود اليومية',
    'Improve journal entry accuracy',
    'تسجيل جميع القيود اليومية بدقة ووفق المعايير المحاسبية دون أخطاء جوهرية.',
    'Record all journal entries accurately and in accordance with accounting standards without material errors.',
    'First-time-right percentage',
    'نسبة القيود الصحيحة من أول مرة',
    'Journal entries correct first time',
    '(correct_first_time_entries / total_entries) * 100',
    '>= 99',
    'Monthly',
    '["FINANCE","GENERAL_LEDGER"]'::jsonb,
    '["ACCOUNTANT","SENIOR_ACCOUNTANT"]'::jsonb,
    20,
    true
  )
on conflict (code) where is_deleted = false and code is not null
do update set
  category = excluded.category,
  title_ar = excluded.title_ar,
  title_en = excluded.title_en,
  description_ar = excluded.description_ar,
  description_en = excluded.description_en,
  measurement_unit_ar = excluded.measurement_unit_ar,
  measurement_unit_en = excluded.measurement_unit_en,
  measurement_formula = excluded.measurement_formula,
  target_formula = excluded.target_formula,
  frequency = excluded.frequency,
  applicable_departments = excluded.applicable_departments,
  applicable_jobs = excluded.applicable_jobs,
  is_active = true;

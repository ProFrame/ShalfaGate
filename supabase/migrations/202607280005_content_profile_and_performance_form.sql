-- Governed content, employee signatures, and the comprehensive performance form.

alter table public.users
  add column if not exists signature_url text;

alter table public.content_items
  add column if not exists title_hi text,
  add column if not exists title_ur text,
  add column if not exists title_tl text,
  add column if not exists description_ar text,
  add column if not exists description_en text,
  add column if not exists external_url text,
  add column if not exists file_type text,
  add column if not exists file_size text,
  add column if not exists display_order integer not null default 0,
  add column if not exists updated_by uuid references auth.users(id);

create unique index if not exists uq_content_items_code_active
  on public.content_items(lower(code))
  where code is not null and not is_deleted;

create index if not exists idx_content_type_order
  on public.content_items(content_type, display_order, publish_date desc)
  where is_published and not is_deleted;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'employee-assets',
  'employee-assets',
  true,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "employees upload own profile assets" on storage.objects;
create policy "employees upload own profile assets"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'employee-assets'
  and (storage.foldername(name))[1] = auth.uid()::text
);

drop policy if exists "employees update own profile assets" on storage.objects;
create policy "employees update own profile assets"
on storage.objects for update to authenticated
using (
  bucket_id = 'employee-assets'
  and (storage.foldername(name))[1] = auth.uid()::text
)
with check (
  bucket_id = 'employee-assets'
  and (storage.foldername(name))[1] = auth.uid()::text
);

drop policy if exists "employees delete own profile assets" on storage.objects;
create policy "employees delete own profile assets"
on storage.objects for delete to authenticated
using (
  bucket_id = 'employee-assets'
  and (storage.foldername(name))[1] = auth.uid()::text
);

drop trigger if exists audit_content_items on public.content_items;
create trigger audit_content_items
after insert or update or delete on public.content_items
for each row execute function public.write_audit_log();

update public.templates
set name = 'Comprehensive Performance Evaluation Form',
    name_ar = 'نموذج تقييم الأداء الشامل',
    name_en = 'Comprehensive Performance Evaluation Form',
    category = 'Performance Management',
    code = 'FM-SH-PER-O-24-0053\V1.3',
    version = 1,
    description_ar = 'نموذج شامل لتقييم الأهداف والجدارات ونتيجة الأداء.',
    description_en = 'A comprehensive form for evaluating objectives, competencies, and overall performance.',
    updated_on = now()
where code = 'PERFORMANCE'
   or code = 'FM-SH-PER-O-24-0053\V1.3';

insert into public.content_items (
  content_type, code, title_ar, title_en, external_url, file_type,
  publish_date, is_published, display_order, version
)
values
  ('Document','DOC-001','لائحة تنظيم العمل المعتمدة لشركة شلفا','Shalfa Approved Work Regulations','https://drive.google.com/file/d/1mKv0QBIAshqiTqZ4-KJMx_dSGMVHAUJM/view?usp=drive_link','pdf','2026-05-12',true,1,'1.0'),
  ('Document','DOC-002','سياسة مكافحة التدخين','Anti-Smoking Policy','https://drive.google.com/file/d/1sg9LMVSec2zkvQbbh8n1mFvSnpjjvHx2/view?usp=drive_link','pdf','2026-05-12',true,2,'1.0'),
  ('Document','DOC-003','دليل الموظف والسجل التدريبي','Employee Handbook and Training Record','https://drive.google.com/file/d/1uGtff_IWNAbXlbnSwQiXLo7RMvPoon8z/view?usp=drive_link','pdf','2026-05-12',true,3,'1.0'),
  ('Document','DOC-004','سياسة المكتب النظيف','Clean Desk Policy','https://drive.google.com/file/d/1S3msWwD0ScTWgMK8Jd7wkhAoFBJtailC/view?usp=drive_link','pdf','2026-05-12',true,4,'1.0'),
  ('Document','DOC-005','دليل تنظيم محطات ومساحات العمل','Workstation and Workspace Organization Guide','https://drive.google.com/file/d/10bp14P6jeGY-HdzxlGmku6pUFTQxyH5r/view?usp=drive_link','pdf','2026-05-12',true,5,'1.0'),
  ('Document','DOC-006','إدارة الأصول','Asset Management','https://drive.google.com/file/d/1SBQb1yna-ZOBslGN0o7-kEJf4W3MurRS/view?usp=drive_link','pdf','2026-05-12',true,6,'1.0'),
  ('Document','DOC-007','سياسة السلامة والصحة المهنية','Occupational Safety and Health Policy','https://drive.google.com/file/d/1fkE8E_ZTKYz3XBMgITXBsAkF7BUvrZlU/view?usp=drive_link','pdf','2026-05-12',true,7,'1.0'),
  ('Document','DOC-008','سياسة المشتريات','Procurement Policy','https://drive.google.com/file/d/1Z7jmOQUkISz0W7tOpINeSpbZxZBDeuOA/view?usp=drive_link','pdf','2026-05-12',true,8,'1.0'),
  ('Document','DOC-009','سياسة إدارة العهدة النقدية','Petty Cash Management Policy','https://drive.google.com/file/d/10A47ujdSj6jiFof5NlVLLEZ4k0VjhY2P/view?usp=drive_link','pdf','2026-05-12',true,9,'1.0'),
  ('Document','DOC-010','سياسة الاحتفاظ بالمستندات','Document Retention Policy','https://drive.google.com/file/d/1270pKXpK1WELQJ2I849GiEfSQO49Vl_S/view?usp=drive_link','pdf','2026-05-12',true,10,'1.0'),
  ('Document','DOC-011','ضوابط قواعد اللباس','Dress Code Guidelines','https://drive.google.com/file/d/1b9wrmkd8eL87iya_34YmGcJqN9_ZMWFg/view?usp=drive_link','pdf','2026-05-12',true,11,'1.0'),
  ('Circular','CIR-001','إعادة تنظيم تبعية قسم التوظيف','Recruitment Department Reporting Restructure','https://drive.google.com/file/d/1tYRJ8RDauKV7jqbaJKyV_6-WfPXNR6Va/view?usp=drive_link','pdf','2026-05-12',true,1,'1.0'),
  ('Circular','CIR-002','إيقاف السلف للموظفين','Suspension of Employee Advances','https://drive.google.com/file/d/1F-cienH1fdlNSA4uoycribDaURPJlHeJ/view?usp=drive_link','pdf','2026-05-12',true,2,'1.0'),
  ('Circular','CIR-003','تعميم مكافحة التدخين','Anti-Smoking Circular','https://drive.google.com/file/d/1HmQw_ddpbs703NGmp8glcffFAYgKUfqX/view?usp=drive_link','pdf','2026-05-12',true,3,'1.0'),
  ('Circular','CIR-004','تعميم ضوابط تواريخ تقديم الإجازات','Leave Submission Date Guidelines','https://drive.google.com/file/d/1FhRtB7Y8GPBOvxDZcULstDqoD4IoVxPJ/view?usp=drive_link','pdf','2026-05-12',true,4,'1.0'),
  ('Circular','CIR-005','تعميم ضوابط الحضور والانصراف','Attendance and Departure Guidelines','https://drive.google.com/file/d/17DJpvhpIow7pjZ78s-7NeE3bDLpROQRz/view?usp=drive_link','pdf','2026-05-12',true,5,'1.0'),
  ('Design','DSN-001','دليل معدات وأدوات السلامة - الإنجليزية','Safety Equipment and PPE Guide','https://drive.google.com/file/d/1QaDfZ5YYHB8ovmoHZIrNSjvPEcJJDE8K/view?usp=drive_link','image','2026-05-12',true,1,'1.0'),
  ('Design','DSN-002','دليل معدات وأدوات السلامة - العربية','Safety Equipment and PPE Guide - Arabic','https://drive.google.com/file/d/1bHI_qDUXAGbIzJsC_IKOn8W3KHvU6Yq4/view?usp=drive_link','image','2026-05-12',true,2,'1.0'),
  ('Design','DSN-003','دليل معدات وأدوات السلامة - الأوردو','Safety Equipment and PPE Guide - Urdu','https://drive.google.com/file/d/1JxMWpotLGwUKvdCxeEYAygBc0scD_2eO/view?usp=drive_link','image','2026-05-12',true,3,'1.0'),
  ('Design','DSN-004','دليل معدات وأدوات السلامة - الهندية','Safety Equipment and PPE Guide - Hindi','https://drive.google.com/file/d/1FncKlZYfbxZ_jQWaczAjOtSLnyFPD0W1/view?usp=drive_link','image','2026-05-12',true,4,'1.0')
on conflict do nothing;

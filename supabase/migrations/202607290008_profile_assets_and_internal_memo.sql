-- Reliable employee profile assets and the reusable internal memo form.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'employee-assets',
  'employee-assets',
  true,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update set
  public = true,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "employees read own profile assets" on storage.objects;
create policy "employees read own profile assets"
on storage.objects for select to authenticated
using (
  bucket_id = 'employee-assets'
  and (storage.foldername(name))[1] = auth.uid()::text
);

insert into storage.buckets (id, name, public, file_size_limit)
values ('form-attachments', 'form-attachments', false, 10485760)
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit;

create table if not exists public.form_attachments (
  id uuid primary key default gen_random_uuid(),
  form_id uuid not null references public.forms(id) on delete cascade,
  file_name text not null,
  storage_path text not null unique,
  mime_type text,
  file_size bigint,
  uploaded_by uuid references auth.users(id),
  is_deleted boolean not null default false,
  created_on timestamptz not null default now()
);

create index if not exists idx_form_attachments_form
  on public.form_attachments(form_id, created_on)
  where not is_deleted;

alter table public.form_attachments enable row level security;

drop policy if exists "form owners read attachments" on public.form_attachments;
create policy "form owners read attachments"
on public.form_attachments for select to authenticated
using (
  exists (
    select 1 from public.forms f
    where f.id = form_id
      and (f.employee_id = auth.uid() or f.requested_by = auth.uid() or public.has_permission('Forms.Approve'))
  )
);

drop policy if exists "form owners add attachments" on public.form_attachments;
create policy "form owners add attachments"
on public.form_attachments for insert to authenticated
with check (
  uploaded_by = auth.uid()
  and exists (
    select 1 from public.forms f
    where f.id = form_id and f.requested_by = auth.uid()
  )
);

drop policy if exists "form owners upload files" on storage.objects;
create policy "form owners upload files"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'form-attachments'
  and (storage.foldername(name))[1] = auth.uid()::text
);

drop policy if exists "form owners read files" on storage.objects;
create policy "form owners read files"
on storage.objects for select to authenticated
using (
  bucket_id = 'form-attachments'
  and (storage.foldername(name))[1] = auth.uid()::text
);

insert into public.templates (
  code, name, name_ar, name_en, description_ar, description_en,
  category, version, is_active
)
values (
  'FM-SH-INM-R-23-0025\V1.2',
  'Internal Memo Form',
  'نموذج مذكرة داخلية',
  'Internal Memo Form',
  'نموذج موحد لإعداد وحفظ وطباعة المذكرات الداخلية.',
  'A standardized form for preparing, saving and printing internal memos.',
  'Organization Development',
  1,
  true
)
on conflict (code) do update set
  name = excluded.name,
  name_ar = excluded.name_ar,
  name_en = excluded.name_en,
  description_ar = excluded.description_ar,
  description_en = excluded.description_en,
  category = excluded.category,
  version = excluded.version,
  is_active = excluded.is_active;

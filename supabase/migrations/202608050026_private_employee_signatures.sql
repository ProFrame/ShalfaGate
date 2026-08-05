-- Keep employee signatures out of the public avatar bucket.
-- The application stores a path in users.signature_url for new signatures and
-- resolves it to a short-lived signed URL only for an authenticated viewer.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'employee-signatures',
  'employee-signatures',
  false,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create or replace function public.employee_asset_is_known_user(p_path text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.users u
    where u.id::text = split_part(coalesce(p_path, ''), '/', 1)
      and not u.is_deleted
  );
$$;

revoke all on function public.employee_asset_is_known_user(text) from public;
grant execute on function public.employee_asset_is_known_user(text) to authenticated;

drop policy if exists "employees read private signatures" on storage.objects;
create policy "employees read private signatures"
on storage.objects for select to authenticated
using (
  bucket_id = 'employee-signatures'
  and public.employee_asset_is_known_user(name)
);

drop policy if exists "employees upload private signatures" on storage.objects;
create policy "employees upload private signatures"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'employee-signatures'
  and (storage.foldername(name))[1] = auth.uid()::text
);

drop policy if exists "employees update private signatures" on storage.objects;
create policy "employees update private signatures"
on storage.objects for update to authenticated
using (
  bucket_id = 'employee-signatures'
  and (storage.foldername(name))[1] = auth.uid()::text
)
with check (
  bucket_id = 'employee-signatures'
  and (storage.foldername(name))[1] = auth.uid()::text
);

drop policy if exists "employees delete private signatures" on storage.objects;
create policy "employees delete private signatures"
on storage.objects for delete to authenticated
using (
  bucket_id = 'employee-signatures'
  and (storage.foldername(name))[1] = auth.uid()::text
);

-- Existing approval rows and profiles contain public URLs. Keep their logical
-- object path so the client can resolve them from the private bucket after the
-- object is moved. Historical avatar URLs are deliberately untouched.
update public.users
set signature_url = regexp_replace(
  signature_url,
  '^https?://[^/]+/storage/v1/object/public/employee-assets/',
  ''
)
where signature_url ~* '^https?://[^/]+/storage/v1/object/public/employee-assets/.+/(signature|signature-)[^/]*$';

update public.form_approval_transactions
set actor_signature_url = regexp_replace(
  actor_signature_url,
  '^https?://[^/]+/storage/v1/object/public/employee-assets/',
  ''
)
where actor_signature_url ~* '^https?://[^/]+/storage/v1/object/public/employee-assets/.+/(signature|signature-)[^/]*$';

update public.forms
set data_json = jsonb_set(
  data_json,
  '{evaluator_signature_url}',
  to_jsonb(regexp_replace(data_json->>'evaluator_signature_url', '^https?://[^/]+/storage/v1/object/public/employee-assets/', ''))
)
where data_json->>'evaluator_signature_url' ~* '^https?://[^/]+/storage/v1/object/public/employee-assets/.+/(signature|signature-)[^/]*$';

update public.forms
set data_json = jsonb_set(
  data_json,
  '{requester_signature_url}',
  to_jsonb(regexp_replace(data_json->>'requester_signature_url', '^https?://[^/]+/storage/v1/object/public/employee-assets/', ''))
)
where data_json->>'requester_signature_url' ~* '^https?://[^/]+/storage/v1/object/public/employee-assets/.+/(signature|signature-)[^/]*$';

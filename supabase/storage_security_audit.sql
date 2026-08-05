-- Read-only production audit. Run in Supabase SQL Editor with metadata access.

-- 1) Authoritative bucket inventory.
select id, name, public as is_public, file_size_limit,
       allowed_mime_types, created_at, updated_at
from storage.buckets
order by id;

-- 2) Every storage.objects policy.
select policyname, permissive, roles, cmd, qual, with_check
from pg_catalog.pg_policies
where schemaname = 'storage' and tablename = 'objects'
order by policyname;

-- 3) Public buckets. This should normally contain only tenant-branding.
select id, name, public as is_public
from storage.buckets
where public
order by id;

-- 4) Buckets referenced by the application but missing from production.
with expected(id, expected_public, purpose) as (
  values
    ('tenant-branding', true,  'public tenant logos and cover images'),
    ('employee-assets', false, 'private employee avatars/signatures'),
    ('form-attachments', false, 'private form attachments'),
    ('tenant-files', false, 'optional Supabase extended-storage provider')
)
select e.id, e.expected_public, e.purpose, b.public as actual_public,
       case when b.id is null then 'MISSING'
            when b.public is distinct from e.expected_public then 'WRONG_VISIBILITY'
            else 'OK' end as status
from expected e
left join storage.buckets b on b.id = e.id
order by e.id;

-- 5) RLS status for public tables and storage.objects.
select n.nspname as schema_name, c.relname as relation_name,
       c.relrowsecurity as rls_enabled, c.relforcerowsecurity as rls_forced
from pg_catalog.pg_class c
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
where (n.nspname = 'public' and c.relkind = 'r')
   or (n.nspname = 'storage' and c.relname = 'objects')
order by n.nspname, c.relname;

-- 6) RPC grants. Review every anon row; service_role should be limited to jobs.
select routine_schema, routine_name, specific_name, grantee, privilege_type
from information_schema.routine_privileges
where routine_schema = 'public'
  and grantee in ('anon', 'authenticated', 'service_role')
order by routine_name, grantee;

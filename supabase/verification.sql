-- Run after migrations and seed. Returns one row with deployment totals.
select
  (select count(*)
   from pg_catalog.pg_tables
   where schemaname = 'public') as tables,
  (select count(*)
   from pg_catalog.pg_indexes
   where schemaname = 'public') as indexes,
  (select count(*)
   from information_schema.table_constraints
   where constraint_schema = 'public'
     and constraint_type = 'FOREIGN KEY') as foreign_keys,
  (select count(*)
   from information_schema.table_constraints
   where constraint_schema = 'public'
     and constraint_type = 'UNIQUE') as unique_constraints,
  (select count(*)
   from pg_catalog.pg_policies
   where schemaname = 'public') as rls_policies,
  (select count(*)
   from information_schema.triggers
   where trigger_schema = 'public') as triggers,
  (select count(distinct routine_name)
   from information_schema.routines
   where routine_schema = 'public') as functions,
  (select count(*)
   from information_schema.views
   where table_schema = 'public') as views;

-- Detailed RLS audit: this result must contain no rows.
select schemaname, tablename
from pg_catalog.pg_tables
where schemaname = 'public'
  and not rowsecurity
order by tablename;

-- Key bootstrap data checks.
select
  (select count(*) from public.roles where not is_deleted) as roles,
  (select count(*) from public.permissions) as permissions,
  (select count(*) from public.proficiency_levels where not is_deleted) as proficiency_levels,
  (select count(*) from public.competencies where not is_deleted) as competencies,
  (select count(*) from public.goals where not is_deleted) as goals,
  (select count(*) from public.evaluation_cycles where not is_deleted) as evaluation_cycles,
  (select count(*) from public.email_templates where not is_deleted) as email_templates;

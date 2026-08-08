$ErrorActionPreference = 'Stop'

<#
  One-time bootstrap for the development project that was migrated through
  the SQL Editor. The schema is already at the latest migration, but the
  Supabase CLI history table is empty/missing. Run this once after exporting:

    $env:SUPABASE_ACCESS_TOKEN = '...'
    $env:SUPABASE_PROJECT_REF = 'rfgiarxlbknduaohlebk'
    $env:SUPABASE_DB_PASSWORD = '...'

  The script marks every file currently present as already applied. Future
  commits can then use `supabase db push` normally and only new files run.
  It never prints the token or database password.
#>

if ([string]::IsNullOrWhiteSpace($env:SUPABASE_ACCESS_TOKEN)) {
  throw 'SUPABASE_ACCESS_TOKEN is required. Create it in Supabase Account Settings > Access Tokens.'
}
if ([string]::IsNullOrWhiteSpace($env:SUPABASE_PROJECT_REF)) {
  throw 'SUPABASE_PROJECT_REF is required (for this project: rfgiarxlbknduaohlebk).'
}
if ([string]::IsNullOrWhiteSpace($env:SUPABASE_DB_PASSWORD)) {
  throw 'SUPABASE_DB_PASSWORD is required. Use the database password from Supabase Project Settings > Database.'
}

$migrationVersions = Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot '..\supabase\migrations') -Filter '*.sql' |
  Sort-Object Name |
  ForEach-Object { ($_.BaseName -split '_', 2)[0] }

if (-not $migrationVersions -or $migrationVersions.Count -lt 1) {
  throw 'No SQL migrations were found under supabase/migrations.'
}

Write-Host "Linking Supabase project $($env:SUPABASE_PROJECT_REF)..."
npx --yes supabase@2.112.0 link --project-ref $env:SUPABASE_PROJECT_REF --password $env:SUPABASE_DB_PASSWORD

Write-Host "Repairing history for $($migrationVersions.Count) migration files..."
npx --yes supabase@2.112.0 migration repair --linked --status applied @migrationVersions

Write-Host 'Verifying that the remote database is up to date...'
npx --yes supabase@2.112.0 db push --linked --dry-run

Write-Host 'History bootstrap completed. Do not run this script again after adding new migrations.'

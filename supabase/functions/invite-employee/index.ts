// Creating and updating an employee account.
//
// The admin centre calls this for three different intentions and they must stay
// distinguishable, because the platform is free and the sheets are large:
//
//   new + active + sendInvite   an invitation goes out and the person sets
//                               their own password
//   new + inactive              the account is created switched off and
//                               nothing is sent — this is the Excel import
//   existing                    the profile, the email and the account state
//                               are updated in place
//
// Everything happens inside the caller's own company. Roles, employee numbers
// and email addresses are unique per company now, not per platform, so every
// lookup below is filtered by tenant and the auth metadata carries tenant_id so
// public.handle_new_user files the new employee under the right company.

import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';

import { errorResponse, isPreflight, jsonResponse, preflightResponse } from '../_shared/cors.ts';

const CORS = { methods: 'POST, OPTIONS' };

/** Legacy display names the admin screen still sends, mapped to role codes. */
const roleCodes: Record<string, string> = {
  Employee: 'EMPLOYEE',
  'Department Coordinator': 'DEPARTMENT_COORDINATOR',
  'Department Manager': 'DEPARTMENT_MANAGER',
  'System Administrator': 'SYSTEM_ADMIN',
  'Platform Administrator': 'PLATFORM_ADMIN',
};

const roleCodeFromName = (role = 'Employee') => roleCodes[role] || String(role).toUpperCase();

const defaultAppUrl = () => (Deno.env.get('APP_URL') ?? 'https://bbnovix.com').replace(/\/+$/, '');

/**
 * The company's own password-set address. The origin is always configured;
 * accepting an arbitrary origin from the request would create an open redirect.
 */
const passwordSetUrl = (slug: string): string =>
  `${defaultAppUrl()}/${slug}/reset-password?auth_action=set-password`;

/** The company the caller is signed in to, and its address. */
const resolveCallerTenant = async (
  admin: SupabaseClient,
  userId: string,
): Promise<{ tenantId: string; slug: string }> => {
  const { data: profile, error } = await admin
    .from('users')
    .select('tenant_id, active_tenant_id')
    .eq('id', userId)
    .maybeSingle();
  if (error) throw error;

  const tenantId = profile?.active_tenant_id || profile?.tenant_id;
  if (!tenantId) throw new Error('NO_TENANT_CONTEXT');

  const { data: tenant, error: tenantError } = await admin
    .from('tenants')
    .select('slug')
    .eq('id', tenantId)
    .maybeSingle();
  if (tenantError) throw tenantError;
  if (!tenant?.slug) throw new Error('TENANT_NOT_FOUND');

  return { tenantId: String(tenantId), slug: String(tenant.slug) };
};

const handle = async (request: Request): Promise<Response> => {
  if (isPreflight(request)) return preflightResponse(request, CORS);

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const callerToken = request.headers.get('Authorization')?.replace('Bearer ', '');
  if (!callerToken) throw new Error('UNAUTHORIZED');

  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
  const { data: caller, error: callerError } = await adminClient.auth.getUser(callerToken);
  if (callerError || !caller.user) throw new Error('UNAUTHORIZED');

  const { data: allowed } = await adminClient.rpc('has_permission_for_user', {
    target_user_id: caller.user.id,
    permission_code: 'Employees.Manage',
  });
  if (!allowed) throw new Error('FORBIDDEN');

  const { tenantId, slug } = await resolveCallerTenant(adminClient, caller.user.id);

  const body = await request.json();
  const {
    userId,
    email,
    employeeNo,
    fullName,
    nameAr,
    nameEn,
    mobile,
    department,
    jobTitle,
    departmentId,
    positionId,
    role = 'Employee',
    active = true,
    // Bulk imports create the account and stay silent; the person is activated
    // by hand afterwards. Unset means "behave as before": invite an active new
    // employee, stay silent for an inactive one.
    sendInvite,
  } = body;
  if (!email || !employeeNo || !fullName) throw new Error('MISSING_REQUIRED_DATA');

  const normalizedEmail = String(email).trim().toLowerCase();
  const normalizedEmployeeNo = String(employeeNo).trim();
  const isActive = Boolean(active);
  const wantsInvite = sendInvite === undefined ? isActive : Boolean(sendInvite) && isActive;

  // Uniqueness is per company: another company may well employ the same person.
  let duplicateQuery = adminClient
    .from('users')
    .select('id,email,employee_no')
    .eq('tenant_id', tenantId)
    .eq('is_deleted', false)
    .or(`email.ilike.${normalizedEmail},employee_no.eq.${normalizedEmployeeNo}`)
    .limit(1);
  if (userId) duplicateQuery = duplicateQuery.neq('id', userId);
  const { data: duplicate, error: duplicateError } = await duplicateQuery.maybeSingle();
  if (duplicateError) throw duplicateError;
  if (duplicate) {
    if (String(duplicate.email).toLowerCase() === normalizedEmail) throw new Error('EMAIL_ALREADY_USED');
    throw new Error('EMPLOYEE_NUMBER_ALREADY_USED');
  }

  const roleCode = roleCodeFromName(role);

  // The employee's company travels in the auth metadata so handle_new_user can
  // create the profile row under it; without this the trigger has no company to
  // resolve and quietly creates nothing.
  const metadata = {
    tenant_id: tenantId,
    tenant_slug: slug,
    role_code: roleCode,
    employee_no: normalizedEmployeeNo,
    full_name: fullName,
    name_ar: nameAr || fullName,
    name_en: nameEn || null,
    mobile,
    department,
    job_title: jobTitle,
    department_id: departmentId || null,
    position_id: positionId || null,
    is_active: isActive,
  };

  let targetUserId = userId;
  let previousEmail: string | undefined;
  let invited = false;

  if (userId) {
    const { data: existingUser, error: existingError } = await adminClient.auth.admin.getUserById(userId);
    if (existingError || !existingUser.user) throw existingError || new Error('EMPLOYEE_NOT_FOUND');
    previousEmail = existingUser.user.email;

    const { error: authUpdateError } = await adminClient.auth.admin.updateUserById(userId, {
      email: normalizedEmail,
      email_confirm: true,
      user_metadata: metadata,
      ban_duration: isActive ? 'none' : '876000h',
    });
    if (authUpdateError) throw authUpdateError;
  } else if (wantsInvite) {
    const { data: invitedUser, error: inviteError } = await adminClient.auth.admin.inviteUserByEmail(normalizedEmail, {
      redirectTo: passwordSetUrl(slug),
      data: metadata,
    });
    if (inviteError) throw inviteError;
    targetUserId = invitedUser.user.id;
    invited = true;
  } else {
    const { data: createdUser, error: createError } = await adminClient.auth.admin.createUser({
      email: normalizedEmail,
      email_confirm: true,
      user_metadata: metadata,
    });
    if (createError) throw createError;
    targetUserId = createdUser.user.id;
    if (!isActive) {
      const { error: banError } = await adminClient.auth.admin.updateUserById(targetUserId, {
        ban_duration: '876000h',
      });
      if (banError) throw banError;
    }
  }

  const profile = {
    employee_no: normalizedEmployeeNo,
    full_name: fullName,
    name_ar: nameAr || fullName,
    name_en: nameEn || null,
    mobile,
    department,
    job_title: jobTitle,
    department_id: departmentId || null,
    position_id: positionId || null,
    is_active: isActive,
    invitation_sent: invited ? true : undefined,
    invitation_sent_on: invited ? new Date().toISOString() : undefined,
    account_activated_on: isActive ? new Date().toISOString() : null,
  };

  const { data: updatedRows, error: profileError } = await adminClient
    .from('users')
    .update(profile)
    .eq('id', targetUserId)
    .eq('tenant_id', tenantId)
    .select('id');

  if (profileError) {
    if (userId && previousEmail && previousEmail !== normalizedEmail) {
      await adminClient.auth.admin.updateUserById(userId, { email: previousEmail, email_confirm: true });
    }
    throw profileError;
  }

  // handle_new_user normally created the row a moment ago. It is written here
  // as well so a company whose trigger was skipped — an account that predates
  // the tenant columns, for instance — still ends up with an employee record.
  if (!updatedRows || updatedRows.length === 0) {
    const { error: insertError } = await adminClient.from('users').insert({
      id: targetUserId,
      tenant_id: tenantId,
      active_tenant_id: tenantId,
      email: normalizedEmail,
      ...profile,
    });
    if (insertError) throw insertError;
  }

  // Roles are company scoped: the same code exists once per company.
  const { data: roleRow, error: roleError } = await adminClient
    .from('roles')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('code', roleCode)
    .eq('is_deleted', false)
    .maybeSingle();
  if (roleError) throw roleError;
  if (!roleRow?.id) throw new Error('ROLE_NOT_FOUND');

  const { error: clearRoleError } = await adminClient
    .from('user_roles')
    .delete()
    .eq('user_id', targetUserId)
    .eq('tenant_id', tenantId);
  if (clearRoleError) throw clearRoleError;

  const { error: assignRoleError } = await adminClient
    .from('user_roles')
    .insert({ tenant_id: tenantId, user_id: targetUserId, role_id: roleRow.id });
  if (assignRoleError) throw assignRoleError;

  // The membership row is what tenant switching and the platform console read.
  await adminClient
    .from('tenant_memberships')
    .upsert({
      tenant_id: tenantId,
      user_id: targetUserId,
      employee_id: targetUserId,
      role_id: roleRow.id,
      status: isActive ? 'Active' : 'Invited',
    }, { onConflict: 'tenant_id,user_id' });

  await adminClient.from('audit_logs').insert({
    tenant_id: tenantId,
    actor_id: caller.user.id,
    action: invited ? 'INVITE' : 'UPDATE',
    entity_type: 'users',
    entity_id: targetUserId,
    new_data: {
      email: normalizedEmail,
      employee_no: normalizedEmployeeNo,
      role_code: roleCode,
      invited,
      email_changed: Boolean(previousEmail && previousEmail !== normalizedEmail),
    },
  });

  return jsonResponse({
    userId: targetUserId,
    invited,
    emailChanged: Boolean(previousEmail && previousEmail !== normalizedEmail),
  }, { request, ...CORS });
};

export default {
  async fetch(request: Request): Promise<Response> {
    try {
      return await handle(request);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'UNKNOWN_ERROR';
      const status = message === 'FORBIDDEN' ? 403 : message === 'UNAUTHORIZED' ? 401 : 400;
      return errorResponse(message, { status, request, ...CORS });
    }
  },
};

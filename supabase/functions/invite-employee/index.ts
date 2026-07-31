import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...corsHeaders, 'Content-Type': 'application/json' },
});

const roleCodes: Record<string, string> = {
  Employee: 'EMPLOYEE',
  'Department Coordinator': 'DEPARTMENT_COORDINATOR',
  'Department Manager': 'DEPARTMENT_MANAGER',
  'System Administrator': 'SYSTEM_ADMIN',
  'Platform Administrator': 'PLATFORM_ADMIN',
};

const roleCodeFromName = (role = 'Employee') => roleCodes[role] || String(role).toUpperCase();

export default {
async fetch(request: Request) {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
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
      redirectTo,
    } = body;
    if (!email || !employeeNo || !fullName) throw new Error('MISSING_REQUIRED_DATA');

    const normalizedEmail = String(email).trim().toLowerCase();
    const normalizedEmployeeNo = String(employeeNo).trim();
    let duplicateQuery = adminClient
      .from('users')
      .select('id,email,employee_no')
      .eq('is_deleted', false)
      .or(`email.ilike.${normalizedEmail},employee_no.eq.${normalizedEmployeeNo}`);
    if (userId) duplicateQuery = duplicateQuery.neq('id', userId);
    const { data: duplicate, error: duplicateError } = await duplicateQuery.maybeSingle();
    if (duplicateError) throw duplicateError;
    if (duplicate) {
      if (String(duplicate.email).toLowerCase() === normalizedEmail) throw new Error('EMAIL_ALREADY_USED');
      throw new Error('EMPLOYEE_NUMBER_ALREADY_USED');
    }

    const metadata = {
      employee_no: normalizedEmployeeNo,
      full_name: fullName,
      name_ar: nameAr || fullName,
      name_en: nameEn || null,
      mobile,
      department,
      job_title: jobTitle,
      department_id: departmentId || null,
      position_id: positionId || null,
      is_active: Boolean(active),
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
        ban_duration: active ? 'none' : '876000h',
      });
      if (authUpdateError) throw authUpdateError;
    } else if (active) {
      const inviteRedirect = redirectTo || Deno.env.get('APP_URL');
      if (!inviteRedirect) throw new Error('REDIRECT_URL_REQUIRED');
      const { data: invitedUser, error: inviteError } = await adminClient.auth.admin.inviteUserByEmail(normalizedEmail, {
        redirectTo: inviteRedirect,
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
      const { error: banError } = await adminClient.auth.admin.updateUserById(targetUserId, {
        ban_duration: '876000h',
      });
      if (banError) throw banError;
    }

    const { error: profileError } = await adminClient
      .from('users')
      .update({
        employee_no: normalizedEmployeeNo,
        full_name: fullName,
        name_ar: nameAr || fullName,
        name_en: nameEn || null,
        mobile,
        department,
        job_title: jobTitle,
        department_id: departmentId || null,
        position_id: positionId || null,
        is_active: Boolean(active),
        invitation_sent: invited ? true : undefined,
        invitation_sent_on: invited ? new Date().toISOString() : undefined,
        account_activated_on: active ? new Date().toISOString() : null,
      })
      .eq('id', targetUserId);

    if (profileError) {
      if (userId && previousEmail && previousEmail !== normalizedEmail) {
        await adminClient.auth.admin.updateUserById(userId, { email: previousEmail, email_confirm: true });
      }
      throw profileError;
    }

    const roleCode = roleCodeFromName(role);
    const { data: roleRow, error: roleError } = await adminClient
      .from('roles')
      .select('id')
      .eq('code', roleCode)
      .eq('is_deleted', false)
      .single();
    if (roleError) throw roleError;

    const { error: clearRoleError } = await adminClient.from('user_roles').delete().eq('user_id', targetUserId);
    if (clearRoleError) throw clearRoleError;
    const { error: assignRoleError } = await adminClient.from('user_roles').insert({ user_id: targetUserId, role_id: roleRow.id });
    if (assignRoleError) throw assignRoleError;

    await adminClient.from('audit_logs').insert({
      actor_id: caller.user.id,
      action: invited ? 'INVITE' : 'UPDATE',
      entity_type: 'users',
      entity_id: targetUserId,
      new_data: {
        email: normalizedEmail,
        employee_no: normalizedEmployeeNo,
        email_changed: Boolean(previousEmail && previousEmail !== normalizedEmail),
      },
    });

    return json({ userId: targetUserId, invited, emailChanged: Boolean(previousEmail && previousEmail !== normalizedEmail) });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'UNKNOWN_ERROR';
    const status = message === 'FORBIDDEN' ? 403 : message === 'UNAUTHORIZED' ? 401 : 400;
    return json({ error: message }, status);
  }
},
};

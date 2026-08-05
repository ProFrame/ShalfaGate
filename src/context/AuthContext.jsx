/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  passwordSetupRequested,
  productionConfigurationMissing,
  supabase,
  useLocalData,
} from '../lib/supabaseClient';
import { DEFAULT_TENANT_SLUG, tenantPath } from '../lib/routing';
import { PRIVATE_EMPLOYEE_BUCKET, resolveEmployeeAssetUrl } from '../lib/storage';

const AuthContext = createContext();
const DEFAULT_IDLE_TIMEOUT_MINUTES = 15;
const DEVICE_ID_KEY = 'bbnovix_device_id';
const LAST_ACTIVITY_KEY = 'bbnovix_last_activity';
const IDLE_LOGOUT_KEY = 'bbnovix_idle_logout';

const demoUser = {
  id: 'demo-user',
  email: 'admin@shalfa.local',
  mobile: '05XXXXXXXX',
  employee_no: '10001',
  full_name: 'أحمد محمد',
  department: 'الموارد البشرية',
  department_id: 'hr',
  job_title: 'مدير النظام',
  nationality: 'سعودي',
  gender: 'ذكر',
  national_id: '10XXXXXXXX',
  project: 'المقر الرئيسي',
  sector: 'الخدمات المشتركة',
  site: 'الرياض',
  role_code: 'PLATFORM_ADMIN',
  role_name: 'مسؤول المنصة',
  avatar_url: '',
  signature_url: '',
};

const browserDeviceId = () => {
  try {
    const existing = localStorage.getItem(DEVICE_ID_KEY);
    if (existing) return existing;
    const created = crypto.randomUUID();
    localStorage.setItem(DEVICE_ID_KEY, created);
    return created;
  } catch {
    return null;
  }
};

export const AuthProvider = ({ children, tenantSlug = null, securitySettings = {} }) => {
  const [session, setSession] = useState(null);
  const demoModeAvailable = useLocalData && !productionConfigurationMissing;
  const [profile, setProfile] = useState(demoModeAvailable ? demoUser : null);
  const [memberships, setMemberships] = useState([]);
  const [membershipError, setMembershipError] = useState(null);
  const [loading, setLoading] = useState(!useLocalData);
  const activeSlug = tenantSlug || DEFAULT_TENANT_SLUG;
  const [demoAuthenticated, setDemoAuthenticated] = useState(
    () => demoModeAvailable && localStorage.getItem('bbnovix_demo_session') === 'active'
  );
  const [isPasswordSetup, setIsPasswordSetup] = useState(passwordSetupRequested);
  const pendingPasswordSetup = useRef(passwordSetupRequested);
  const idleTimeoutMs = Math.min(
    24 * 60,
    Math.max(1, Number(securitySettings?.session_timeout_minutes) || DEFAULT_IDLE_TIMEOUT_MINUTES),
  ) * 60 * 1000;

  useEffect(() => {
    if (useLocalData) return undefined;

    let isMounted = true;

    // A valid account is not enough: the visitor must be a member of the
    // company whose address they opened, otherwise they are signed out.
    const enterCorrectTenant = async () => {
      const { data: tenants } = await supabase.rpc('my_tenants');
      const list = Array.isArray(tenants) ? tenants : [];
      if (isMounted) setMemberships(list);
      if (!list.length) return true;

      const target = list.find((item) => item.slug === activeSlug);
      if (!target) {
        if (isMounted) setMembershipError('NOT_A_MEMBER');
        await supabase.auth.signOut();
        return false;
      }
      if (!target.is_active) {
        await supabase.rpc('switch_tenant', { p_tenant_id: target.tenant_id });
      }
      if (isMounted) setMembershipError(null);
      return true;
    };

    const loadProfile = async (userId) => {
      const inRightTenant = await enterCorrectTenant();
      if (!inRightTenant) return;

      let result = await supabase
        .from('users')
        .select('*, user_roles(roles(code, name_ar, name_en))')
        .eq('id', userId)
        .single();
      if (result.error) {
        result = await supabase.from('users').select('*').eq('id', userId).single();
      }
      if (isMounted && result.data) {
        const assignedRole = result.data.user_roles?.[0]?.roles;
        const storedSignature = result.data.signature_url || '';
        const signaturePath = storedSignature && !/^https?:\/\//i.test(storedSignature)
          ? storedSignature
          : null;
        const signatureUrl = signaturePath
          ? await resolveEmployeeAssetUrl(signaturePath)
          : storedSignature;
        setProfile({
          ...result.data,
          signature_path: signaturePath,
          signature_url: signatureUrl,
          role_code: assignedRole?.code || 'EMPLOYEE',
          role_name_1: assignedRole?.name_ar || null,
          role_name_2: assignedRole?.name_en || null,
        });
      }
    };

    const openPasswordSetup = () => {
      pendingPasswordSetup.current = false;
      const url = new URL(window.location.href);
      url.searchParams.delete('auth_action');
      const search = url.searchParams.toString();
      window.history.replaceState(
        null,
        '',
        `${tenantPath(activeSlug, 'reset-password')}${search ? `?${search}` : ''}`,
      );
      setIsPasswordSetup(true);
    };

    supabase.auth.getSession().then(({ data }) => {
      if (!isMounted) return;
      setSession(data.session);
      if (data.session?.user?.id) {
        loadProfile(data.session.user.id);
      } else {
        setProfile(null);
      }
      if (data.session && pendingPasswordSetup.current) openPasswordSetup();
      setLoading(false);
    });

    const { data: listener } = supabase.auth.onAuthStateChange((event, nextSession) => {
      setSession(nextSession);
      if (nextSession?.user?.id) {
        loadProfile(nextSession.user.id);
        if (pendingPasswordSetup.current || event === 'PASSWORD_RECOVERY') openPasswordSetup();
      } else {
        setProfile(null);
      }
    });

    return () => {
      isMounted = false;
      listener.subscription.unsubscribe();
    };
  }, [activeSlug]);

  useEffect(() => {
    const authenticated = useLocalData ? demoModeAvailable && demoAuthenticated : Boolean(session);
    if (!authenticated || isPasswordSetup) {
      localStorage.removeItem(LAST_ACTIVITY_KEY);
      return undefined;
    }

    let timeoutId;
    let lastRecorded = 0;
    let signingOut = false;

    const logoutForInactivity = async () => {
      if (signingOut) return;
      signingOut = true;
      localStorage.removeItem(LAST_ACTIVITY_KEY);
      sessionStorage.setItem(IDLE_LOGOUT_KEY, 'true');
      if (useLocalData) {
        localStorage.removeItem('bbnovix_demo_session');
        setDemoAuthenticated(false);
      } else {
        await supabase.auth.signOut();
      }
      window.location.assign(tenantPath(activeSlug, 'login'));
    };

    const scheduleLogout = () => {
      window.clearTimeout(timeoutId);
      const lastActivity = Number(localStorage.getItem(LAST_ACTIVITY_KEY));
      const elapsed = Date.now() - lastActivity;
      if (!lastActivity || elapsed >= idleTimeoutMs) {
        logoutForInactivity();
        return;
      }
      timeoutId = window.setTimeout(logoutForInactivity, idleTimeoutMs - elapsed);
    };

    const recordActivity = () => {
      const now = Date.now();
      if (now - lastRecorded < 1000) return;
      lastRecorded = now;
      localStorage.setItem(LAST_ACTIVITY_KEY, String(now));
      scheduleLogout();
    };

    const checkVisibility = () => {
      if (document.visibilityState === 'visible') scheduleLogout();
    };
    const syncActivity = (event) => {
      if (event.key === LAST_ACTIVITY_KEY) scheduleLogout();
    };

    if (!localStorage.getItem(LAST_ACTIVITY_KEY)) {
      localStorage.setItem(LAST_ACTIVITY_KEY, String(Date.now()));
    }
    scheduleLogout();

    const events = ['pointerdown', 'pointermove', 'keydown', 'scroll', 'touchstart'];
    events.forEach((eventName) => window.addEventListener(eventName, recordActivity, { passive: true }));
    document.addEventListener('visibilitychange', checkVisibility);
    window.addEventListener('storage', syncActivity);

    return () => {
      window.clearTimeout(timeoutId);
      events.forEach((eventName) => window.removeEventListener(eventName, recordActivity));
      document.removeEventListener('visibilitychange', checkVisibility);
      window.removeEventListener('storage', syncActivity);
    };
  }, [activeSlug, demoAuthenticated, demoModeAvailable, idleTimeoutMs, isPasswordSetup, session]);

  const value = useMemo(
    () => ({
      session,
      profile,
      loading,
      isAuthenticated: useLocalData ? demoModeAvailable && demoAuthenticated : Boolean(session),
      isDemoMode: demoModeAvailable,
      isPasswordSetup,
      memberships,
      membershipError,
      tenantSlug: activeSlug,
      async switchTenant(tenantId) {
        if (useLocalData) return { error: null };
        const { error } = await supabase.rpc('switch_tenant', { p_tenant_id: tenantId });
        if (!error) {
          const target = memberships.find((item) => item.tenant_id === tenantId);
          if (target) window.location.assign(tenantPath(target.slug, 'app'));
        }
        return { error };
      },
      async signInWithPassword(email, password) {
        if (productionConfigurationMissing) {
          return { error: new Error('SERVICE_CONFIGURATION_MISSING') };
        }
        if (useLocalData) {
          // A context has no access to t(), so it reports a stable code and the
          // sign-in page turns it into wording (see AuthPage.authErrorMessage,
          // which resolves anything it does not recognise to t('auth_error') —
          // "check your details and try again", the right message here).
          // The code itself is translated as error_email_and_password_required.
          if (!email || !password) return { error: new Error('EMAIL_AND_PASSWORD_REQUIRED') };
          localStorage.setItem('bbnovix_demo_session', 'active');
          localStorage.setItem(LAST_ACTIVITY_KEY, String(Date.now()));
          setDemoAuthenticated(true);
          return { data: { user: demoUser }, error: null };
        }
        const normalizedEmail = email.trim().toLowerCase();
        const result = await supabase.auth.signInWithPassword({ email: normalizedEmail, password });
        // This RPC is audit-only; Supabase Auth remains the actual credential
        // gate. Migration 0023 refuses forged successful events from anon.
        await supabase.rpc('record_login', {
          p_success: !result.error,
          p_email: normalizedEmail,
          p_device_hash: browserDeviceId(),
          p_user_agent: navigator.userAgent,
        });
        return result;
      },
      async resetPassword(email) {
        if (productionConfigurationMissing) {
          return { error: new Error('SERVICE_CONFIGURATION_MISSING') };
        }
        if (useLocalData) return { error: null };
        return supabase.auth.resetPasswordForEmail(email, {
          redirectTo: `${window.location.origin}${tenantPath(activeSlug, 'reset-password')}?auth_action=set-password`,
        });
      },
      async updatePassword(password) {
        if (useLocalData) return { error: null };
        const result = await supabase.auth.updateUser({ password });
        if (!result.error) {
          await supabase.rpc('record_first_login');
          setIsPasswordSetup(false);
        }
        return result;
      },
      async updateProfile(changes) {
        if (useLocalData) {
          setProfile((current) => ({ ...current, ...changes }));
          return { error: null };
        }
        const { error } = await supabase.from('users').update(changes).eq('id', session.user.id);
        if (!error) setProfile((current) => ({ ...current, ...changes }));
        return { error };
      },
      async uploadProfileAsset(file, kind) {
        const field = kind === 'signature' ? 'signature_url' : 'avatar_url';
        if (useLocalData) {
          const dataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(file);
          });
          setProfile((current) => ({ ...current, [field]: dataUrl }));
          return { data: dataUrl, error: null };
        }

        const extension = file.type === 'image/png' ? 'png' : file.type === 'image/webp' ? 'webp' : 'jpg';
        const path = `${session.user.id}/${kind}-${Date.now()}.${extension}`;
        const bucket = kind === 'signature' ? PRIVATE_EMPLOYEE_BUCKET : 'employee-assets';
        const { error: uploadError } = await supabase.storage
          .from(bucket)
          .upload(path, file, { upsert: false, contentType: file.type || 'image/png', cacheControl: '3600' });
        if (uploadError) return { data: null, error: uploadError };

        const publicUrl = kind === 'signature'
          ? await resolveEmployeeAssetUrl(path)
          : supabase.storage.from(bucket).getPublicUrl(path).data.publicUrl;
        const storedValue = kind === 'signature' ? path : publicUrl;
        const { error } = await supabase.from('users').update({ [field]: storedValue }).eq('id', session.user.id);
        if (!error) {
          const { data: existing } = await supabase.storage.from(bucket).list(session.user.id);
          const obsolete = (existing || [])
            .filter((item) => item.name.startsWith(`${kind}-`) && item.name !== path.split('/').pop())
            .map((item) => `${session.user.id}/${item.name}`);
          if (obsolete.length) await supabase.storage.from(bucket).remove(obsolete);
          setProfile((current) => ({
            ...current,
            [field]: publicUrl,
            ...(kind === 'signature' ? { signature_path: path } : {}),
          }));
        } else {
          await supabase.storage.from(bucket).remove([path]);
        }
        return { data: publicUrl, error };
      },
      async deleteProfileAsset(kind) {
        const field = kind === 'signature' ? 'signature_url' : 'avatar_url';
        if (useLocalData) {
          setProfile((current) => ({ ...current, [field]: null }));
          return { error: null };
        }
        const bucket = kind === 'signature' ? PRIVATE_EMPLOYEE_BUCKET : 'employee-assets';
        const { data: existing, error: listError } = await supabase.storage.from(bucket).list(session.user.id);
        if (listError) return { error: listError };
        const paths = (existing || []).filter((item) => item.name.startsWith(`${kind}-`) || item.name.startsWith(`${kind}.`)).map((item) => `${session.user.id}/${item.name}`);
        if (paths.length) {
          const { error: removeError } = await supabase.storage.from(bucket).remove(paths);
          if (removeError) return { error: removeError };
        }
        const { error } = await supabase.from('users').update({ [field]: null }).eq('id', session.user.id);
        if (!error) setProfile((current) => ({
          ...current,
          [field]: null,
          ...(kind === 'signature' ? { signature_path: null } : {}),
        }));
        return { error };
      },
      async signOut() {
        localStorage.removeItem(LAST_ACTIVITY_KEY);
        if (useLocalData) {
          localStorage.removeItem('bbnovix_demo_session');
          setDemoAuthenticated(false);
          return;
        }
        await supabase.auth.signOut();
      },
    }),
    [activeSlug, demoAuthenticated, demoModeAvailable, isPasswordSetup, loading, membershipError, memberships, profile, session]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export const useAuth = () => useContext(AuthContext);

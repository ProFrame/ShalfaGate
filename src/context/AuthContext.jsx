/* eslint-disable react-refresh/only-export-components */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  passwordSetupRequested,
  productionConfigurationMissing,
  supabase,
  useLocalData,
} from '../lib/supabaseClient';
import { DEFAULT_TENANT_SLUG, tenantPath } from '../lib/routing';
import { resetMyScreensCache } from '../data/notificationCenterService';
import {
  PRIVATE_EMPLOYEE_BUCKET, CORE_BUCKETS, STORAGE_LAYER,
  putFile, getStorageProvider, unregisterObjectsByPath, resolveEmployeeAssetUrl,
} from '../lib/storage';

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

/** True for a company's own top administrator (not the platform operator). */
export const isAdminRole = (roleCode) => roleCode === 'PLATFORM_ADMIN' || roleCode === 'SYSTEM_ADMIN';

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
        resetMyScreensCache();
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
      resetMyScreensCache();
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

  // Before this migration, every avatar/signature lived flat at
  // {userId}/{kind}-{timestamp}.{ext} directly under the user's top-level
  // folder. putFile()+userPath() now nests new uploads at {userId}/{kind}/{file}
  // instead (see src/lib/storage/paths.js), so a real employee's already-existing
  // file is invisible to a listing of the new nested folder alone — cleanup/
  // delete must still find it, or "delete signature" would report success
  // while the file (privacy-sensitive for a signature) silently remains in
  // the bucket forever. Not exposed on the context value — internal to
  // uploadProfileAsset/deleteProfileAsset below. Safe to remove once no
  // legacy flat file is expected to remain (every employee has re-uploaded
  // at least once since this shipped).
  const legacyFlatPaths = useCallback(async (provider, kind) => {
    const { data: topLevel } = await provider.list(session.user.id);
    return (topLevel || [])
      .filter((item) => item.name.startsWith(`${kind}-`) || item.name.startsWith(`${kind}.`))
      .map((item) => `${session.user.id}/${item.name}`);
  }, [session]);

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
          resetMyScreensCache();
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
        // A self-service profile form may only ever touch these columns. The
        // database enforces the same boundary (guard_user_self_update on
        // public.users freezes everything else, and active_tenant_id can only
        // move through switchTenant), but a request never sends a field it was
        // not asked to send in the first place.
        const editable = ['full_name', 'name_ar', 'name_en', 'mobile'];
        const safeChanges = Object.fromEntries(
          Object.entries(changes || {}).filter(([key]) => editable.includes(key))
        );
        if (Object.keys(safeChanges).length === 0) return { error: null };

        if (useLocalData) {
          setProfile((current) => ({ ...current, ...safeChanges }));
          return { error: null };
        }
        const { error } = await supabase.from('users').update(safeChanges).eq('id', session.user.id);
        if (!error) setProfile((current) => ({ ...current, ...safeChanges }));
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

        const bucket = kind === 'signature' ? PRIVATE_EMPLOYEE_BUCKET : CORE_BUCKETS.employee;
        // Core layer, user-scoped path (employee-assets/employee-signatures RLS is
        // keyed on the uploader's own auth id, not the tenant) — see
        // src/lib/storage/index.js putFile()'s pathScope. Goes through the same
        // check-upload-register sequence as every other module now, instead of
        // talking to supabase.storage directly.
        const { data, error: uploadError } = await putFile({
          layer: STORAGE_LAYER.CORE,
          pathScope: 'user',
          ownerId: session.user.id,
          area: kind,
          file,
          bucket,
          entityType: 'User',
          entityId: session.user.id,
        });
        if (uploadError) return { data: null, error: uploadError };

        const publicUrl = kind === 'signature'
          ? await resolveEmployeeAssetUrl(data.path)
          : data.url;
        const storedValue = kind === 'signature' ? data.path : publicUrl;
        const { error } = await supabase.from('users').update({ [field]: storedValue }).eq('id', session.user.id);
        if (!error) {
          // Old files of this kind live in the same {uid}/{kind}/ subfolder as
          // the one just uploaded (putFile's userPath scoping) — list that
          // subfolder, not the user's top-level folder, or every entry here
          // would be a single pseudo-folder that never matches by name. Also
          // sweep any pre-migration flat-shaped file (see legacyFlatPaths).
          const provider = await getStorageProvider(STORAGE_LAYER.CORE, { bucket });
          const { data: existing } = await provider.list(`${session.user.id}/${kind}`);
          const uploadedName = data.path.split('/').pop();
          const obsolete = (existing || [])
            .filter((item) => item.name !== uploadedName)
            .map((item) => `${session.user.id}/${kind}/${item.name}`);
          obsolete.push(...await legacyFlatPaths(provider, kind));
          if (obsolete.length) {
            await provider.remove(obsolete);
            await unregisterObjectsByPath(obsolete);
          }
          setProfile((current) => ({
            ...current,
            [field]: publicUrl,
            ...(kind === 'signature' ? { signature_path: data.path } : {}),
          }));
        } else {
          const provider = await getStorageProvider(STORAGE_LAYER.CORE, { bucket });
          await provider.remove([data.path]);
          await unregisterObjectsByPath([data.path]);
        }
        return { data: publicUrl, error };
      },
      async deleteProfileAsset(kind) {
        const field = kind === 'signature' ? 'signature_url' : 'avatar_url';
        if (useLocalData) {
          setProfile((current) => ({ ...current, [field]: null }));
          return { error: null };
        }
        const bucket = kind === 'signature' ? PRIVATE_EMPLOYEE_BUCKET : CORE_BUCKETS.employee;
        const provider = await getStorageProvider(STORAGE_LAYER.CORE, { bucket });
        const { data: existing, error: listError } = await provider.list(`${session.user.id}/${kind}`);
        if (listError) return { error: listError };
        const paths = (existing || []).map((item) => `${session.user.id}/${kind}/${item.name}`);
        // A pre-migration flat-shaped file (never nested) is not "inside" the
        // {kind}/ folder above, so it would otherwise survive a delete while
        // the UI reports success — see legacyFlatPaths.
        paths.push(...await legacyFlatPaths(provider, kind));
        if (paths.length) {
          const { error: removeError } = await provider.remove(paths);
          if (removeError) return { error: removeError };
          await unregisterObjectsByPath(paths);
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
        resetMyScreensCache();
        if (useLocalData) {
          localStorage.removeItem('bbnovix_demo_session');
          setDemoAuthenticated(false);
          return;
        }
        await supabase.auth.signOut();
      },
    }),
    [activeSlug, demoAuthenticated, demoModeAvailable, isPasswordSetup, legacyFlatPaths, loading, membershipError, memberships, profile, session]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export const useAuth = () => useContext(AuthContext);

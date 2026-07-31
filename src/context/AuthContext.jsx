/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { passwordSetupRequested, supabase, useLocalData } from '../lib/supabaseClient';

const AuthContext = createContext();
const IDLE_TIMEOUT_MS = 15 * 60 * 1000;
const LAST_ACTIVITY_KEY = 'shalfa_last_activity';
const IDLE_LOGOUT_KEY = 'shalfa_idle_logout';

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

export const AuthProvider = ({ children }) => {
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(useLocalData ? demoUser : null);
  const [loading, setLoading] = useState(!useLocalData);
  const [demoAuthenticated, setDemoAuthenticated] = useState(
    () => localStorage.getItem('shalfa_demo_session') === 'active'
  );
  const [isPasswordSetup, setIsPasswordSetup] = useState(passwordSetupRequested);
  const pendingPasswordSetup = useRef(passwordSetupRequested);

  useEffect(() => {
    if (useLocalData) return undefined;

    let isMounted = true;

    const loadProfile = async (userId) => {
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
        setProfile({
          ...result.data,
          role_code: assignedRole?.code || 'EMPLOYEE',
          role_name: assignedRole?.name_ar || 'موظف',
        });
      }
    };

    const openPasswordSetup = () => {
      pendingPasswordSetup.current = false;
      const url = new URL(window.location.href);
      url.searchParams.delete('auth_action');
      window.history.replaceState(null, '', `${url.pathname}${url.search}#/reset-password`);
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
  }, []);

  useEffect(() => {
    const authenticated = useLocalData ? demoAuthenticated : Boolean(session);
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
        localStorage.removeItem('shalfa_demo_session');
        setDemoAuthenticated(false);
      } else {
        await supabase.auth.signOut();
      }
      window.location.hash = '#/login';
    };

    const scheduleLogout = () => {
      window.clearTimeout(timeoutId);
      const lastActivity = Number(localStorage.getItem(LAST_ACTIVITY_KEY));
      const elapsed = Date.now() - lastActivity;
      if (!lastActivity || elapsed >= IDLE_TIMEOUT_MS) {
        logoutForInactivity();
        return;
      }
      timeoutId = window.setTimeout(logoutForInactivity, IDLE_TIMEOUT_MS - elapsed);
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
  }, [demoAuthenticated, isPasswordSetup, session]);

  const value = useMemo(
    () => ({
      session,
      profile,
      loading,
      isAuthenticated: useLocalData ? demoAuthenticated : Boolean(session),
      isDemoMode: useLocalData,
      isPasswordSetup,
      async signInWithPassword(email, password) {
        if (useLocalData) {
          if (!email || !password) return { error: new Error('أدخل البريد الإلكتروني وكلمة المرور.') };
          localStorage.setItem('shalfa_demo_session', 'active');
          localStorage.setItem(LAST_ACTIVITY_KEY, String(Date.now()));
          setDemoAuthenticated(true);
          return { data: { user: demoUser }, error: null };
        }
        return supabase.auth.signInWithPassword({ email: email.trim().toLowerCase(), password });
      },
      async resetPassword(email) {
        if (useLocalData) return { error: null };
        return supabase.auth.resetPasswordForEmail(email, {
          redirectTo: `${window.location.origin}${window.location.pathname}?auth_action=set-password`,
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
        const { error: uploadError } = await supabase.storage
          .from('employee-assets')
          .upload(path, file, { upsert: false, contentType: file.type || 'image/png', cacheControl: '3600' });
        if (uploadError) return { data: null, error: uploadError };

        const { data } = supabase.storage.from('employee-assets').getPublicUrl(path);
        const publicUrl = data.publicUrl;
        const { error } = await supabase.from('users').update({ [field]: publicUrl }).eq('id', session.user.id);
        if (!error) {
          const { data: existing } = await supabase.storage.from('employee-assets').list(session.user.id);
          const obsolete = (existing || [])
            .filter((item) => item.name.startsWith(`${kind}-`) && item.name !== path.split('/').pop())
            .map((item) => `${session.user.id}/${item.name}`);
          if (obsolete.length) await supabase.storage.from('employee-assets').remove(obsolete);
          setProfile((current) => ({ ...current, [field]: publicUrl }));
        } else {
          await supabase.storage.from('employee-assets').remove([path]);
        }
        return { data: publicUrl, error };
      },
      async deleteProfileAsset(kind) {
        const field = kind === 'signature' ? 'signature_url' : 'avatar_url';
        if (useLocalData) {
          setProfile((current) => ({ ...current, [field]: null }));
          return { error: null };
        }
        const { data: existing, error: listError } = await supabase.storage.from('employee-assets').list(session.user.id);
        if (listError) return { error: listError };
        const paths = (existing || []).filter((item) => item.name.startsWith(`${kind}-`) || item.name.startsWith(`${kind}.`)).map((item) => `${session.user.id}/${item.name}`);
        if (paths.length) {
          const { error: removeError } = await supabase.storage.from('employee-assets').remove(paths);
          if (removeError) return { error: removeError };
        }
        const { error } = await supabase.from('users').update({ [field]: null }).eq('id', session.user.id);
        if (!error) setProfile((current) => ({ ...current, [field]: null }));
        return { error };
      },
      async signOut() {
        localStorage.removeItem(LAST_ACTIVITY_KEY);
        if (useLocalData) {
          localStorage.removeItem('shalfa_demo_session');
          setDemoAuthenticated(false);
          return;
        }
        await supabase.auth.signOut();
      },
    }),
    [demoAuthenticated, isPasswordSetup, loading, profile, session]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export const useAuth = () => useContext(AuthContext);

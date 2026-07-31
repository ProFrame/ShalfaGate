import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
const authHashParams = new URLSearchParams(window.location.hash.startsWith('#') ? window.location.hash.slice(1) : window.location.hash);
const authSearchParams = new URLSearchParams(window.location.search);
const authAction = authSearchParams.get('auth_action');
const authCallbackType = authHashParams.get('type');
const hasAuthCallbackPayload = Boolean(
  authHashParams.get('access_token')
  || authHashParams.get('error')
  || authSearchParams.get('code')
  || authSearchParams.get('token_hash')
  || ['invite', 'recovery'].includes(authCallbackType)
);

export const passwordSetupRequested = (
  authAction === 'set-password' && hasAuthCallbackPayload
) || ['invite', 'recovery'].includes(authCallbackType);

if (authAction === 'set-password' && !hasAuthCallbackPayload) {
  authSearchParams.delete('auth_action');
  const cleanSearch = authSearchParams.toString();
  window.history.replaceState(
    null,
    '',
    `${window.location.pathname}${cleanSearch ? `?${cleanSearch}` : ''}${window.location.hash}`
  );
}

export const hasSupabaseConfig = Boolean(
  supabaseUrl &&
    supabaseAnonKey &&
    !supabaseUrl.includes('your-project-id') &&
    !supabaseAnonKey.includes('your-anon-key')
);

export const useLocalData = !hasSupabaseConfig || (
  import.meta.env.DEV &&
  ['localhost', '127.0.0.1'].includes(window.location.hostname) &&
  new URLSearchParams(window.location.search).get('preview') === '1'
);

export const supabase = hasSupabaseConfig
  ? createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    })
  : null;

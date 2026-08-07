// The branded sign-in page of a company address.
//
// The wording never names a product or a company: a visitor signs in to "the
// Digital Workplace Platform". What identifies the company is its own logo
// and its own cover image, and a company that stored neither falls back to
// the platform cover with no logo at all.

import { useState } from 'react';
import { ArrowRight, Eye, EyeOff, LockKeyhole, Mail, ScanSearch } from 'lucide-react';
import { Link, Redirect, useLocation } from 'wouter';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { useTenant } from '../context/TenantContext';
import LanguageSwitcher from './LanguageSwitcher';
import TenantLogo, { useTenantLogo } from './branding/TenantLogo';
import portalHero from '../assets/portal-hero.webp';

const AuthPage = () => {
  const { signInWithPassword, resetPassword, isAuthenticated, isPasswordSetup, membershipError } = useAuth();
  const { t } = useLanguage();
  const { branding } = useTenant();
  // The cover is a dark photograph, so the logo sits on a light plate above it.
  const { hasLogo } = useTenantLogo('light');
  const [, navigate] = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [forgot, setForgot] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(() => {
    if (sessionStorage.getItem('bbnovix_idle_logout') !== 'true') return '';
    sessionStorage.removeItem('bbnovix_idle_logout');
    return t('idle_session_expired');
  });

  // Signing in with a valid account that belongs to another company signs the
  // visitor straight back out; without this they would just see the form again
  // and have no idea why.
  const notice = membershipError === 'NOT_A_MEMBER' ? t('auth_not_a_member') : message;

  if (isAuthenticated) return <Redirect to={isPasswordSetup ? '/reset-password' : '/app'} replace />;

  const heroImage = branding?.hero_image_url?.trim() || portalHero;

  const authErrorMessage = (error) => {
    const message = String(error?.message || '').toLowerCase();
    if (message.includes('service_configuration_missing')) return t('auth_configuration_error');
    if (message.includes('email_and_password_required')) return t('error_email_and_password_required');
    if (message.includes('not_a_member')) return t('auth_not_a_member');
    if (error?.status === 429 || message.includes('rate limit')) return t('auth_rate_limited');
    if (message.includes('email not confirmed')) return t('auth_email_not_confirmed');
    if (message.includes('invalid login credentials')) return t('auth_invalid_credentials');
    if (message.includes('failed to fetch') || message.includes('network')) return t('auth_network_error');
    return t('auth_error');
  };

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setMessage('');
    const result = forgot ? await resetPassword(email) : await signInWithPassword(email, password);
    setBusy(false);
    if (result.error) {
      setMessage(authErrorMessage(result.error));
      return;
    }
    if (forgot) setMessage(t('reset_sent'));
    else navigate('/app');
  };

  return (
    <main className="auth-page">
      <section className="auth-visual" style={{ backgroundImage: `url(${heroImage})` }}>
        <div className="auth-visual-overlay" />
        {hasLogo && (
          <Link href="/" className="auth-brand"><TenantLogo variant="light" /></Link>
        )}
        <div className="auth-visual-copy">
          <span>{t('employee_portal_brand')}</span>
          <h1>{t('auth_visual_title')}</h1>
          <p>{t('auth_visual_text')}</p>
        </div>
      </section>

      <section className="auth-panel">
        <LanguageSwitcher className="auth-language-switcher" />
        <div className="auth-form-wrap">
          <Link href="/" className="auth-back"><ArrowRight size={18} aria-hidden="true" /> {t('back_home')}</Link>
          <div className="auth-heading">
            <div className="auth-lock" aria-hidden="true"><LockKeyhole size={22} /></div>
            <div>
              <p>{forgot ? t('recover_account') : t('welcome_back')}</p>
              <h2>{forgot ? t('reset_password') : t('sign_in_to_portal')}</h2>
            </div>
          </div>
          <p className="auth-subtitle">{forgot ? t('reset_help') : t('sign_in_help')}</p>

          <form onSubmit={submit} className="auth-form">
            <label>
              <span>{t('work_email')}</span>
              <div className="input-with-icon">
                <Mail size={18} aria-hidden="true" />
                <input
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  required
                  autoComplete="email"
                  placeholder={t('email_placeholder')}
                />
              </div>
            </label>
            {!forgot && (
              <label>
                <span>{t('password')}</span>
                <div className="input-with-icon">
                  <LockKeyhole size={18} aria-hidden="true" />
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    required
                    autoComplete="current-password"
                  />
                  <button type="button" onClick={() => setShowPassword((value) => !value)} aria-label={t('show_password')} aria-pressed={showPassword}>
                    {showPassword ? <EyeOff size={18} aria-hidden="true" /> : <Eye size={18} aria-hidden="true" />}
                  </button>
                </div>
              </label>
            )}
            <button className="primary-button auth-submit" disabled={busy}>
              {busy ? t('checking') : forgot ? t('send_reset_link') : t('login')}
            </button>
          </form>

          <div className="auth-message-live" role="status" aria-live="polite">
            {notice && <div className="auth-message">{notice}</div>}
          </div>
          <button className="text-button auth-forgot" onClick={() => { setForgot((value) => !value); setMessage(''); }}>
            {forgot ? t('return_to_login') : t('forgot_password')}
          </button>
          <p className="auth-help">{t('auth_help')}</p>
          <Link href="/verify" className="auth-verify-link"><ScanSearch size={16} aria-hidden="true" /> {t('verify_title')}</Link>
        </div>
      </section>
    </main>
  );
};

export default AuthPage;

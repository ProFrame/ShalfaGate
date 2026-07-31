import { useState } from 'react';
import { ArrowRight, Eye, EyeOff, LockKeyhole, Mail } from 'lucide-react';
import { Link, Redirect, useLocation } from 'wouter';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import LanguageSwitcher from './LanguageSwitcher';
import logo from '../assets/logo.png';
import portalHero from '../assets/portal-hero.png';

const AuthPage = () => {
  const { signInWithPassword, resetPassword, isAuthenticated, isPasswordSetup } = useAuth();
  const { t } = useLanguage();
  const [, navigate] = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [forgot, setForgot] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(() => {
    if (sessionStorage.getItem('shalfa_idle_logout') !== 'true') return '';
    sessionStorage.removeItem('shalfa_idle_logout');
    return t('idle_session_expired');
  });

  if (isAuthenticated) return <Redirect to={isPasswordSetup ? '/reset-password' : '/app'} replace />;

  const authErrorMessage = (error) => {
    const message = String(error?.message || '').toLowerCase();
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
      <section className="auth-visual" style={{ backgroundImage: `url(${portalHero})` }}>
        <div className="auth-visual-overlay" />
        <Link href="/" className="auth-brand"><img src={logo} alt="Shalfa" /></Link>
        <div className="auth-visual-copy">
          <span>{t('employee_portal')}</span>
          <h1>{t('auth_visual_title')}</h1>
          <p>{t('auth_visual_text')}</p>
        </div>
      </section>

      <section className="auth-panel">
        <LanguageSwitcher className="auth-language-switcher" />
        <div className="auth-form-wrap">
          <Link href="/" className="auth-back"><ArrowRight size={18} /> {t('back_home')}</Link>
          <div className="auth-heading">
            <div className="auth-lock"><LockKeyhole size={22} /></div>
            <div>
              <p>{forgot ? t('recover_account') : t('welcome_back')}</p>
              <h2>{forgot ? t('reset_password') : t('sign_in_to')}</h2>
            </div>
          </div>
          <p className="auth-subtitle">{forgot ? t('reset_help') : t('sign_in_help')}</p>

          <form onSubmit={submit} className="auth-form">
            <label>
              <span>{t('work_email')}</span>
              <div className="input-with-icon">
                <Mail size={18} />
                <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required autoComplete="email" placeholder="name@company.com" />
              </div>
            </label>
            {!forgot && (
              <label>
                <span>{t('password')}</span>
                <div className="input-with-icon">
                  <LockKeyhole size={18} />
                  <input type={showPassword ? 'text' : 'password'} value={password} onChange={(event) => setPassword(event.target.value)} required autoComplete="current-password" />
                  <button type="button" onClick={() => setShowPassword((value) => !value)} aria-label={t('show_password')}>
                    {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                  </button>
                </div>
              </label>
            )}
            <button className="primary-button auth-submit" disabled={busy}>
              {busy ? t('checking') : forgot ? t('send_reset_link') : t('login')}
            </button>
          </form>

          {message && <div className="auth-message">{message}</div>}
          <button className="text-button auth-forgot" onClick={() => { setForgot((value) => !value); setMessage(''); }}>
            {forgot ? t('return_to_login') : t('forgot_password')}
          </button>
          <p className="auth-help">{t('auth_help')}</p>
        </div>
      </section>
    </main>
  );
};

export default AuthPage;

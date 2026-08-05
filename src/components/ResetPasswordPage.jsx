// Password setup and recovery, reached from an invitation or a reset link.
//
// It carries the same branding rules as the landing and sign-in pages: the
// company logo when there is one, nothing when there is not, and wording that
// never names a product.

import { useState } from 'react';
import { CheckCircle2, Eye, EyeOff, KeyRound, LockKeyhole } from 'lucide-react';
import { Link } from 'wouter';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { useTenant } from '../context/TenantContext';
import LanguageSwitcher from './LanguageSwitcher';
import TenantLogo from './branding/TenantLogo';
import './branding/branding.css';

const ResetPasswordPage = () => {
  const { loading, session, updatePassword, signOut } = useAuth();
  const { t } = useLanguage();
  const { settings } = useTenant();
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [complete, setComplete] = useState(false);
  const minimumLength = Math.min(128, Math.max(8, Number(settings?.password_min_length) || 8));

  const submit = async (event) => {
    event.preventDefault();
    setError('');
    if (password.length < minimumLength) {
      setError(t('password_minimum', { min: minimumLength }));
      return;
    }
    if (settings?.password_require_upper && !/[A-Z]/.test(password)) {
      setError(t('password_upper_required'));
      return;
    }
    if (settings?.password_require_number && !/[0-9]/.test(password)) {
      setError(t('password_number_required'));
      return;
    }
    if (settings?.password_require_symbol && !/[^A-Za-z0-9\s]/.test(password)) {
      setError(t('password_symbol_required'));
      return;
    }
    if (password !== confirmation) {
      setError(t('passwords_do_not_match'));
      return;
    }
    setBusy(true);
    const result = await updatePassword(password);
    setBusy(false);
    if (result.error) {
      setError(t('password_update_failed'));
      return;
    }
    await signOut();
    setComplete(true);
  };

  if (loading) return <div className="page-loader"><span /></div>;

  return (
    <main className="password-setup-page">
      <header>
        <TenantLogo variant="light" />
        <LanguageSwitcher />
      </header>
      <section className="password-setup-panel">
        {complete ? (
          <div className="password-complete">
            <CheckCircle2 aria-hidden="true" />
            <h1>{t('password_set_success')}</h1>
            <p>{t('password_set_success_note')}</p>
            <Link href="/login" className="primary-button">{t('login')}</Link>
          </div>
        ) : session ? (
          <>
            <span className="password-setup-icon" aria-hidden="true"><KeyRound /></span>
            <span className="section-kicker">{t('account_activation')}</span>
            <h1>{t('set_platform_password')}</h1>
            <p>{t('password_setup_note')}</p>
            <form onSubmit={submit}>
              <label className="field-label">{t('new_password')}
                <div className="input-with-icon">
                  <LockKeyhole aria-hidden="true" />
                  <input type={showPassword ? 'text' : 'password'} value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" required minLength={minimumLength} />
                  <button type="button" onClick={() => setShowPassword((value) => !value)} aria-label={t('show_password')} aria-pressed={showPassword}>
                    {showPassword ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
                  </button>
                </div>
              </label>
              <label className="field-label">{t('confirm_password')}
                <div className="input-with-icon">
                  <LockKeyhole aria-hidden="true" />
                  <input type={showPassword ? 'text' : 'password'} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="new-password" required minLength={minimumLength} />
                </div>
              </label>
              <div role="status" aria-live="polite">
                {error && <div className="auth-message error">{error}</div>}
              </div>
              <button className="primary-button" disabled={busy}>{busy ? t('saving') : t('set_password')}</button>
            </form>
          </>
        ) : (
          <div className="password-complete">
            <KeyRound aria-hidden="true" />
            <h1>{t('invalid_invitation')}</h1>
            <p>{t('invalid_invitation_note')}</p>
            <Link href="/login" className="primary-button">{t('login')}</Link>
          </div>
        )}
      </section>
    </main>
  );
};

export default ResetPasswordPage;

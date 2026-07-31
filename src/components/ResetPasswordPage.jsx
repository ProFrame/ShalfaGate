import { useState } from 'react';
import { CheckCircle2, Eye, EyeOff, KeyRound, LockKeyhole } from 'lucide-react';
import { Link } from 'wouter';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import LanguageSwitcher from './LanguageSwitcher';
import logo from '../assets/logo.png';

const ResetPasswordPage = () => {
  const { loading, session, updatePassword, signOut } = useAuth();
  const { t } = useLanguage();
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [complete, setComplete] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    setError('');
    if (password.length < 8) {
      setError(t('password_minimum'));
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
      <header><img src={logo} alt="Shalfa" /><LanguageSwitcher /></header>
      <section className="password-setup-panel">
        {complete ? (
          <div className="password-complete">
            <CheckCircle2 />
            <h1>{t('password_set_success')}</h1>
            <p>{t('password_set_success_note')}</p>
            <Link href="/login" className="primary-button">{t('login')}</Link>
          </div>
        ) : session ? (
          <>
            <span className="password-setup-icon"><KeyRound /></span>
            <span className="section-kicker">{t('account_activation')}</span>
            <h1>{t('set_platform_password')}</h1>
            <p>{t('set_platform_password_note')}</p>
            <form onSubmit={submit}>
              <label className="field-label">{t('new_password')}
                <div className="input-with-icon">
                  <LockKeyhole />
                  <input type={showPassword ? 'text' : 'password'} value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" required minLength="8" />
                  <button type="button" onClick={() => setShowPassword((value) => !value)} aria-label={t('show_password')}>{showPassword ? <EyeOff /> : <Eye />}</button>
                </div>
              </label>
              <label className="field-label">{t('confirm_password')}
                <div className="input-with-icon">
                  <LockKeyhole />
                  <input type={showPassword ? 'text' : 'password'} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="new-password" required minLength="8" />
                </div>
              </label>
              {error && <div className="auth-message error">{error}</div>}
              <button className="primary-button" disabled={busy}>{busy ? t('saving') : t('set_password')}</button>
            </form>
          </>
        ) : (
          <div className="password-complete">
            <KeyRound />
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

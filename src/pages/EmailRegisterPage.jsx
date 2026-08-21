import { useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { signUp } from "../lib/firebase";

function EmailRegisterPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const searchParams = new URLSearchParams(location.search);
  const initialEmail = searchParams.get("email") || "";

  const [email, setEmail] = useState(initialEmail);
  const [isEditingEmail, setIsEditingEmail] = useState(!initialEmail);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [errors, setErrors] = useState({});
  const [signupError, setSignupError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const validate = () => {
    const nextErrors = {};

    if (!email) {
      nextErrors.email = "請輸入 Email";
    } else if (!/\S+@\S+\.\S+/.test(email)) {
      nextErrors.email = "Email 格式不正確";
    }

    if (!password) {
      nextErrors.password = "請輸入密碼";
    } else if (password.length < 8) {
      nextErrors.password = "密碼至少需要 8 個字元";
    }

    if (!confirmPassword) {
      nextErrors.confirmPassword = "請再次輸入密碼";
    } else if (confirmPassword !== password) {
      nextErrors.confirmPassword = "兩次輸入的密碼不一致";
    }

    return nextErrors;
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setSignupError("");

    const validationErrors = validate();
    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors);
      return;
    }

    try {
      setSubmitting(true);
      await signUp(email.trim().toLowerCase(), password);
      navigate("/dashboard", { replace: true });
    } catch (error) {
      console.error("Could not create account:", error);
      setSignupError(
        error.code === "auth/email-already-in-use"
          ? "這個 Email 已經註冊，請改用登入。"
          : "目前無法建立帳號，請稍後再試。",
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="auth-page">
      <header className="auth-brand-bar">
        <Link className="auth-brand-link" to="/">
          <span className="brand-mark dark" aria-hidden="true">
            AP
          </span>
          <span>Afterschool Pay</span>
        </Link>
      </header>

      <section className="auth-card" aria-labelledby="register-title">
        {signupError ? (
          <div className="auth-banner error">{signupError}</div>
        ) : null}

        <h1 id="register-title">建立密碼</h1>

        <form onSubmit={handleSubmit} noValidate>
          <div className="auth-field-block">
            <label className="auth-label">Email</label>
            {isEditingEmail ? (
              <>
                <input
                  autoComplete="email"
                  className="auth-input pill"
                  onChange={(event) => {
                    setEmail(event.target.value);
                    setErrors((current) => ({ ...current, email: "" }));
                  }}
                  placeholder="you@example.com"
                  type="email"
                  value={email}
                />
                {errors.email ? (
                  <p className="auth-error">{errors.email}</p>
                ) : null}
              </>
            ) : (
              <div className="email-pill">
                <span title={email}>{email}</span>
                <button type="button" onClick={() => setIsEditingEmail(true)}>
                  修改
                </button>
              </div>
            )}
          </div>

          <div className="auth-field-block">
            <label className="auth-label" htmlFor="register-password">
              密碼
            </label>
            <div className="password-shell">
              <input
                autoComplete="new-password"
                id="register-password"
                onChange={(event) => {
                  setPassword(event.target.value);
                  setErrors((current) => ({ ...current, password: "" }));
                }}
                placeholder="至少 8 個字元"
                type={showPassword ? "text" : "password"}
                value={password}
              />
              <button
                aria-label={showPassword ? "隱藏密碼" : "顯示密碼"}
                onClick={() => setShowPassword((current) => !current)}
                type="button"
              >
                {showPassword ? "隱藏" : "顯示"}
              </button>
            </div>
            {errors.password ? (
              <p className="auth-error">{errors.password}</p>
            ) : null}
          </div>

          <div className="auth-field-block">
            <label className="auth-label" htmlFor="register-confirm-password">
              確認密碼
            </label>
            <div className="password-shell">
              <input
                autoComplete="new-password"
                id="register-confirm-password"
                onChange={(event) => {
                  setConfirmPassword(event.target.value);
                  setErrors((current) => ({
                    ...current,
                    confirmPassword: "",
                  }));
                }}
                placeholder="再次輸入密碼"
                type={showConfirmPassword ? "text" : "password"}
                value={confirmPassword}
              />
              <button
                aria-label={
                  showConfirmPassword
                    ? "隱藏確認密碼"
                    : "顯示確認密碼"
                }
                onClick={() => setShowConfirmPassword((current) => !current)}
                type="button"
              >
                {showConfirmPassword ? "隱藏" : "顯示"}
              </button>
            </div>
            {errors.confirmPassword ? (
              <p className="auth-error">{errors.confirmPassword}</p>
            ) : null}
          </div>

          <button className="auth-page-button" disabled={submitting}>
            {submitting ? "建立中..." : "建立帳號"}
          </button>
        </form>
      </section>

      <footer className="auth-terms-row">
        <Link to="/">回首頁</Link>
        <span>|</span>
        <Link to={`/login?email=${encodeURIComponent(email)}`}>登入</Link>
      </footer>
    </main>
  );
}

export default EmailRegisterPage;

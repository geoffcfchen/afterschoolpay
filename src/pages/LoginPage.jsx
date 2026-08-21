import { useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { signIn } from "../lib/firebase";

function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const searchParams = new URLSearchParams(location.search);
  const initialEmail = searchParams.get("email") || "";

  const [email, setEmail] = useState(initialEmail);
  const [isEditingEmail, setIsEditingEmail] = useState(!initialEmail);
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [errors, setErrors] = useState({});
  const [loginFailed, setLoginFailed] = useState(false);
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
    }

    return nextErrors;
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setLoginFailed(false);

    const validationErrors = validate();
    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors);
      return;
    }

    try {
      setSubmitting(true);
      const isSuccess = await signIn(email.trim().toLowerCase(), password);

      if (isSuccess) {
        navigate("/dashboard");
        return;
      }

      setLoginFailed(true);
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

      <section className="auth-card" aria-labelledby="login-title">
        {loginFailed ? (
          <div className="auth-banner error">Email 或密碼不正確。</div>
        ) : null}

        <h1 id="login-title">輸入密碼</h1>

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
            <label className="auth-label" htmlFor="login-password">
              密碼
            </label>
            <div className="password-shell">
              <input
                autoComplete="current-password"
                id="login-password"
                onChange={(event) => {
                  setPassword(event.target.value);
                  setErrors((current) => ({ ...current, password: "" }));
                }}
                placeholder="請輸入密碼"
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

          <button className="auth-page-button" disabled={submitting}>
            {submitting ? "登入中..." : "繼續"}
          </button>
        </form>
      </section>

      <footer className="auth-terms-row">
        <Link to="/">回首頁</Link>
        <span>|</span>
        <a href="mailto:hello@afterschoolpay.com">聯絡支援</a>
      </footer>
    </main>
  );
}

export default LoginPage;

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
      nextErrors.email = "Email is required";
    } else if (!/\S+@\S+\.\S+/.test(email)) {
      nextErrors.email = "Invalid email address";
    }

    if (!password) {
      nextErrors.password = "Password is required";
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
        navigate("/");
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
          <div className="auth-banner error">Invalid email or password.</div>
        ) : null}

        <h1 id="login-title">Enter your password</h1>

        <form onSubmit={handleSubmit} noValidate>
          <div className="auth-field-block">
            <label className="auth-label">Email address</label>
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
                  Edit
                </button>
              </div>
            )}
          </div>

          <div className="auth-field-block">
            <label className="auth-label" htmlFor="login-password">
              Password
            </label>
            <div className="password-shell">
              <input
                autoComplete="current-password"
                id="login-password"
                onChange={(event) => {
                  setPassword(event.target.value);
                  setErrors((current) => ({ ...current, password: "" }));
                }}
                placeholder="Password"
                type={showPassword ? "text" : "password"}
                value={password}
              />
              <button
                aria-label={showPassword ? "Hide password" : "Show password"}
                onClick={() => setShowPassword((current) => !current)}
                type="button"
              >
                {showPassword ? "Hide" : "Show"}
              </button>
            </div>
            {errors.password ? (
              <p className="auth-error">{errors.password}</p>
            ) : null}
          </div>

          <button className="auth-page-button" disabled={submitting}>
            {submitting ? "Signing in..." : "Continue"}
          </button>
        </form>
      </section>

      <footer className="auth-terms-row">
        <Link to="/">Back to home</Link>
        <span>|</span>
        <a href="mailto:hello@afterschoolpay.com">Support</a>
      </footer>
    </main>
  );
}

export default LoginPage;

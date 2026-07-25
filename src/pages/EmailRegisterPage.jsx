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
      nextErrors.email = "Email is required";
    } else if (!/\S+@\S+\.\S+/.test(email)) {
      nextErrors.email = "Invalid email address";
    }

    if (!password) {
      nextErrors.password = "Password is required";
    } else if (password.length < 8) {
      nextErrors.password = "Password must be at least 8 characters";
    }

    if (!confirmPassword) {
      nextErrors.confirmPassword = "Please confirm your password";
    } else if (confirmPassword !== password) {
      nextErrors.confirmPassword = "Passwords do not match";
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
          ? "This email is already in use. Try logging in instead."
          : "Could not create your account. Please try again.",
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

        <h1 id="register-title">Create your password</h1>

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
            <label className="auth-label" htmlFor="register-password">
              Password
            </label>
            <div className="password-shell">
              <input
                autoComplete="new-password"
                id="register-password"
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

          <div className="auth-field-block">
            <label className="auth-label" htmlFor="register-confirm-password">
              Confirm password
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
                placeholder="Confirm password"
                type={showConfirmPassword ? "text" : "password"}
                value={confirmPassword}
              />
              <button
                aria-label={
                  showConfirmPassword
                    ? "Hide confirm password"
                    : "Show confirm password"
                }
                onClick={() => setShowConfirmPassword((current) => !current)}
                type="button"
              >
                {showConfirmPassword ? "Hide" : "Show"}
              </button>
            </div>
            {errors.confirmPassword ? (
              <p className="auth-error">{errors.confirmPassword}</p>
            ) : null}
          </div>

          <button className="auth-page-button" disabled={submitting}>
            {submitting ? "Creating..." : "Create account"}
          </button>
        </form>
      </section>

      <footer className="auth-terms-row">
        <Link to="/">Back to home</Link>
        <span>|</span>
        <Link to={`/login?email=${encodeURIComponent(email)}`}>Log in</Link>
      </footer>
    </main>
  );
}

export default EmailRegisterPage;

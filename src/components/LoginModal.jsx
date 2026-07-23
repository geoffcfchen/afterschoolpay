import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { getSignInMethods, signInWithGoogle } from "../lib/firebase";

function LoginModal({ open, onClose }) {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [emailError, setEmailError] = useState("");
  const [checkingEmail, setCheckingEmail] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        onClose?.();
      }
    };

    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      document.body.style.overflow = originalOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, onClose]);

  if (!open) {
    return null;
  }

  const stopPropagation = (event) => event.stopPropagation();

  const handleGoogleSignIn = async () => {
    try {
      setGoogleLoading(true);
      const user = await signInWithGoogle();

      if (!user) {
        return;
      }

      onClose?.();
      navigate("/");
    } catch (error) {
      console.error("Google login failed in modal:", error);
      setEmailError("Google sign in is not ready yet. Check Firebase setup.");
    } finally {
      setGoogleLoading(false);
    }
  };

  const handleContinue = async () => {
    const trimmedEmail = email.trim().toLowerCase();
    setEmailError("");

    if (!trimmedEmail) {
      setEmailError("Email is required");
      return;
    }

    if (!/\S+@\S+\.\S+/.test(trimmedEmail)) {
      setEmailError("Invalid email address");
      return;
    }

    try {
      setCheckingEmail(true);
      const methods = await getSignInMethods(trimmedEmail);
      const hasPassword = methods.includes("password");
      const hasGoogle = methods.includes("google.com");

      if (methods.length === 0) {
        onClose?.();
        navigate(`/register-email?email=${encodeURIComponent(trimmedEmail)}`);
        return;
      }

      if (hasPassword) {
        onClose?.();
        navigate(`/login?email=${encodeURIComponent(trimmedEmail)}`);
        return;
      }

      if (hasGoogle) {
        setEmailError(
          "This email uses Google sign in. Please continue with Google.",
        );
        return;
      }

      setEmailError("This email is linked to a different sign in method.");
    } catch (error) {
      console.error("Unable to check sign in methods:", error);
      setEmailError("Unable to check this email right now. Please try again.");
    } finally {
      setCheckingEmail(false);
    }
  };

  const handleKeyDown = (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      handleContinue();
    }
  };

  return (
    <div className="auth-backdrop" onClick={onClose}>
      <section
        aria-labelledby="login-modal-title"
        aria-modal="true"
        className="auth-dialog"
        onClick={stopPropagation}
        role="dialog"
      >
        <button
          aria-label="Close login dialog"
          className="auth-close-button"
          onClick={onClose}
          type="button"
        >
          x
        </button>

        <h2 id="login-modal-title">Log in or sign up</h2>
        <p>
          Enter your email to get started, or continue with Google if your
          program already uses it.
        </p>

        <button
          className="provider-button"
          disabled={googleLoading}
          onClick={handleGoogleSignIn}
          type="button"
        >
          <span className="provider-mark" aria-hidden="true">
            G
          </span>
          <span>{googleLoading ? "Signing in..." : "Continue with Google"}</span>
        </button>

        <div className="auth-divider">
          <span />
          <strong>OR</strong>
          <span />
        </div>

        <label className="auth-label" htmlFor="login-email">
          Email address
        </label>
        <input
          autoComplete="email"
          className="auth-input"
          id="login-email"
          onChange={(event) => {
            setEmail(event.target.value);
            setEmailError("");
          }}
          onKeyDown={handleKeyDown}
          placeholder="you@example.com"
          type="email"
          value={email}
        />

        {emailError ? <p className="auth-error">{emailError}</p> : null}

        <button
          className="auth-primary-button"
          disabled={checkingEmail}
          onClick={handleContinue}
          type="button"
        >
          {checkingEmail ? "Checking..." : "Continue"}
        </button>

        <p className="auth-fine-print">
          By continuing, you agree to Afterschool Pay account and payment
          notices.
        </p>
      </section>
    </div>
  );
}

export default LoginModal;

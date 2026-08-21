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
      navigate("/dashboard");
    } catch (error) {
      console.error("Google login failed in modal:", error);
      setEmailError("Google 登入尚未設定完成，請確認 Firebase 設定。");
    } finally {
      setGoogleLoading(false);
    }
  };

  const handleContinue = async () => {
    const trimmedEmail = email.trim().toLowerCase();
    setEmailError("");

    if (!trimmedEmail) {
      setEmailError("請輸入 Email");
      return;
    }

    if (!/\S+@\S+\.\S+/.test(trimmedEmail)) {
      setEmailError("Email 格式不正確");
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
        setEmailError("這個 Email 使用 Google 登入，請按上方 Google 按鈕。");
        return;
      }

      setEmailError("這個 Email 使用其他登入方式。");
    } catch (error) {
      console.error("Unable to check sign in methods:", error);
      setEmailError("目前無法檢查 Email，請稍後再試。");
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
          aria-label="關閉登入視窗"
          className="auth-close-button"
          onClick={onClose}
          type="button"
        >
          x
        </button>

        <h2 id="login-modal-title">登入或建立帳號</h2>
        <p>
          請輸入 Email 開始使用。若你的帳號已綁定 Google，也可以直接用
          Google 登入。
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
          <span>{googleLoading ? "登入中..." : "使用 Google 繼續"}</span>
        </button>

        <div className="auth-divider">
          <span />
          <strong>或</strong>
          <span />
        </div>

        <label className="auth-label" htmlFor="login-email">
          Email
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
          {checkingEmail ? "檢查中..." : "繼續"}
        </button>

        <p className="auth-fine-print">
          繼續代表你同意建立 Afterschool Pay 帳號並接收系統通知。
        </p>
      </section>
    </div>
  );
}

export default LoginModal;

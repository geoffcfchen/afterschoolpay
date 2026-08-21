import { useEffect, useState } from "react";
import { onAuthStateChanged, signOut } from "firebase/auth";
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";
import { auth } from "../lib/firebase";
import { ensureUserProfile, saveUserDisplayName } from "../lib/orgData";

function getSafeNextPath(value) {
  if (
    !value ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.startsWith("/profile-setup")
  ) {
    return "/dashboard";
  }

  return value;
}

function ProfileSetupPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const searchParams = new URLSearchParams(location.search);
  const nextPath = getSafeNextPath(searchParams.get("next"));
  const isEditingProfile = searchParams.get("edit") === "1";
  const [authStatus, setAuthStatus] = useState(auth ? "checking" : "error");
  const [currentUser, setCurrentUser] = useState(null);
  const [displayName, setDisplayName] = useState("");
  const [errorMessage, setErrorMessage] = useState(
    auth ? "" : "這個版本尚未設定 Firebase。",
  );
  const [saveStatus, setSaveStatus] = useState("idle");

  useEffect(() => {
    if (!auth) {
      return undefined;
    }

    let active = true;
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      if (!active) {
        return;
      }

      setCurrentUser(user);

      if (!user) {
        setAuthStatus("signed-out");
        return;
      }

      setAuthStatus("loading");
      setErrorMessage("");

      try {
        const profile = await ensureUserProfile(user);

        if (!active) {
          return;
        }

        if (profile.displayName && !isEditingProfile) {
          navigate(nextPath, { replace: true });
          return;
        }

        setDisplayName(profile.displayName || user.displayName || "");
        setAuthStatus("ready");
      } catch (error) {
        console.error("Unable to load profile setup:", error);

        if (active) {
          setErrorMessage("目前無法載入帳號資料。請確認 Firestore rules 已發布。");
          setAuthStatus("error");
        }
      }
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [isEditingProfile, navigate, nextPath]);

  const handleSignOut = async () => {
    if (!auth) {
      return;
    }

    await signOut(auth);
    navigate("/");
  };

  const handleSubmit = async (event) => {
    event.preventDefault();

    if (!currentUser) {
      return;
    }

    const trimmedName = displayName.trim();

    if (!trimmedName) {
      setErrorMessage("請輸入你的姓名。");
      return;
    }

    setSaveStatus("saving");
    setErrorMessage("");

    try {
      await saveUserDisplayName(currentUser, trimmedName);
      navigate(nextPath, { replace: true });
    } catch (error) {
      console.error("Unable to save display name:", error);
      setErrorMessage("目前無法儲存姓名。請確認 Firestore rules 已發布後再試一次。");
      setSaveStatus("idle");
    }
  };

  if (authStatus === "signed-out") {
    return <Navigate replace to="/" />;
  }

  if (authStatus === "checking" || authStatus === "loading") {
    return (
      <main className="auth-page">
        <div className="dashboard-loading">
          <span className="brand-mark dark" aria-hidden="true">
            AP
          </span>
          <p>正在載入帳號資料...</p>
        </div>
      </main>
    );
  }

  return (
    <main className="auth-page">
      <header className="auth-brand-bar org-setup-bar">
        <Link className="auth-brand-link" to="/">
          <span className="brand-mark dark" aria-hidden="true">
            AP
          </span>
          <span>Afterschool Pay</span>
        </Link>
        <button
          className="dashboard-sign-out"
          onClick={handleSignOut}
          type="button"
        >
          登出
        </button>
      </header>

      <section
        className="auth-card profile-setup-card"
        aria-labelledby="profile-name-title"
      >
        <p className="dashboard-kicker">
          {isEditingProfile ? "姓名設定" : "第一次登入"}
        </p>
        <h1 id="profile-name-title">
          {isEditingProfile ? "修改你的姓名" : "請輸入你的姓名"}
        </h1>
        <p className="profile-setup-copy">
          系統會使用這個名稱顯示在控制台、團隊權限與操作紀錄中。
        </p>

        {errorMessage ? (
          <div className="auth-banner error">{errorMessage}</div>
        ) : null}

        <form onSubmit={handleSubmit} noValidate>
          <div className="auth-field-block">
            <label className="auth-label" htmlFor="profile-display-name">
              姓名
            </label>
            <input
              autoComplete="name"
              className="auth-input pill"
              id="profile-display-name"
              onChange={(event) => {
                setDisplayName(event.target.value);
                setErrorMessage("");
              }}
              placeholder="例如：陳主任"
              value={displayName}
            />
          </div>

          <button
            className="auth-page-button"
            disabled={saveStatus === "saving"}
          >
            {saveStatus === "saving"
              ? "儲存中..."
              : isEditingProfile
                ? "更新姓名"
                : "儲存並繼續"}
          </button>
          {isEditingProfile ? (
            <Link className="profile-setup-cancel" to={nextPath}>
              取消
            </Link>
          ) : null}
        </form>
      </section>
    </main>
  );
}

export default ProfileSetupPage;

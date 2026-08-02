import { useEffect, useState } from "react";
import { onAuthStateChanged, signOut } from "firebase/auth";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { auth } from "../lib/firebase";
import {
  createOrganizationForUser,
  listOrganizations,
  requestOrganizationAccess,
} from "../lib/orgData";

function OrganizationSetupPage() {
  const navigate = useNavigate();
  const [authStatus, setAuthStatus] = useState(auth ? "checking" : "error");
  const [currentUser, setCurrentUser] = useState(null);
  const [organizations, setOrganizations] = useState([]);
  const [organizationName, setOrganizationName] = useState("");
  const [organizationListStatus, setOrganizationListStatus] = useState("idle");
  const [selectedOrganizationId, setSelectedOrganizationId] = useState("");
  const [status, setStatus] = useState("idle");
  const [message, setMessage] = useState("");

  const isSaving = status === "creating" || status === "joining";

  useEffect(() => {
    if (!auth) {
      return undefined;
    }

    let active = true;
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      if (!active) {
        return;
      }

      setCurrentUser(user);
      setAuthStatus(user ? "ready" : "signed-out");

      if (!user) {
        return;
      }

      setOrganizationListStatus("loading");

      listOrganizations()
        .then((records) => {
          if (!active) {
            return;
          }

          setOrganizations(records);
          setSelectedOrganizationId((currentSelection) => {
            if (
              records.some(
                (organization) => organization.id === currentSelection,
              )
            ) {
              return currentSelection;
            }

            return records[0]?.id || "";
          });
          setOrganizationListStatus("ready");
        })
        .catch((error) => {
          console.error("Unable to load organizations:", error);

          if (!active) {
            return;
          }

          setOrganizations([]);
          setSelectedOrganizationId("");
          setOrganizationListStatus("error");
          setMessage(
            "無法載入既有組織。請確認 Firestore rules 已發布後再試一次。",
          );
        });
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const handleSignOut = async () => {
    if (!auth) {
      return;
    }

    await signOut(auth);
    navigate("/");
  };

  const handleRequestAccess = async () => {
    const orgId = selectedOrganizationId;

    if (!currentUser || !orgId) {
      setStatus("error");
      setMessage("請先選擇要加入的組織。");
      return;
    }

    setStatus("joining");
    setMessage("");

    try {
      await requestOrganizationAccess(currentUser, orgId);
      navigate("/dashboard", { replace: true });
    } catch (error) {
      console.error("Unable to request organization access:", error);
      setStatus("error");
      setMessage("無法送出加入申請。請確認 Firestore rules 已發布後再試一次。");
    }
  };

  const handleCreateOrganization = async (event) => {
    event.preventDefault();
    const name = organizationName.trim();

    if (!currentUser || !name) {
      setStatus("error");
      setMessage("請輸入組織名稱。");
      return;
    }

    setStatus("creating");
    setMessage("");

    try {
      await createOrganizationForUser(currentUser, name);
      navigate("/students-courses", { replace: true });
    } catch (error) {
      console.error("Unable to create organization:", error);
      setStatus("error");
      setMessage("無法建立組織。請確認 Firestore rules 已發布後再試一次。");
    }
  };

  if (authStatus === "signed-out") {
    return <Navigate replace to="/" />;
  }

  if (authStatus === "checking") {
    return (
      <main className="auth-page">
        <div className="dashboard-loading">
          <span className="brand-mark dark" aria-hidden="true">
            AP
          </span>
          <p>正在載入組織設定...</p>
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

      <section className="org-setup-shell" aria-labelledby="org-setup-title">
        <div className="org-setup-heading">
          <p className="dashboard-kicker">組織設定</p>
          <h1 id="org-setup-title">建立或加入組織</h1>
          <p>
            帳號是個人身份；組織是學校或補習班的工作空間。你可以選擇現有組織送出申請，
            或建立新組織並成為等級 1 負責人。
          </p>
        </div>

        {message ? <div className="auth-banner error">{message}</div> : null}

        <div className="org-setup-grid">
          <form className="org-option-panel" onSubmit={handleCreateOrganization}>
            <p className="dashboard-kicker">建立新組織</p>
            <h2>成為新組織負責人</h2>
            <label className="auth-label" htmlFor="organization-name">
              組織名稱
            </label>
            <input
              className="auth-input pill"
              id="organization-name"
              onChange={(event) => {
                setOrganizationName(event.target.value);
                setMessage("");
              }}
              placeholder="例如：互動霧峰加盟校"
              value={organizationName}
            />
            <p>
              建立後你會成為等級 1 負責人，可以再到團隊權限邀請與開通其他人。
            </p>
            <button className="auth-page-button" disabled={isSaving}>
              {status === "creating" ? "建立中..." : "建立組織"}
            </button>
          </form>

          <section className="org-option-panel">
            <p className="dashboard-kicker">加入既有組織</p>
            <h2>請負責人開通權限</h2>

            {organizationListStatus === "loading" ? (
              <div className="org-list-state">正在載入既有組織...</div>
            ) : null}

            {organizationListStatus === "error" ? (
              <div className="org-list-state error">目前無法讀取組織清單。</div>
            ) : null}

            {organizationListStatus === "ready" && organizations.length === 0 ? (
              <div className="org-list-state">
                目前沒有可加入的組織。請建立新組織。
              </div>
            ) : null}

            {organizations.length > 0 ? (
              <div className="org-choice-list" role="radiogroup">
                {organizations.map((organization) => {
                  const selected = selectedOrganizationId === organization.id;

                  return (
                    <label
                      className={selected ? "selected" : ""}
                      key={organization.id}
                    >
                      <input
                        checked={selected}
                        name="organization"
                        onChange={() => {
                          setSelectedOrganizationId(organization.id);
                          setMessage("");
                        }}
                        type="radio"
                        value={organization.id}
                      />
                      <span>
                        <strong>{organization.name}</strong>
                        <em>
                          選擇後會送出加入申請，等待負責人設定你的角色與分校權限。
                        </em>
                      </span>
                    </label>
                  );
                })}
              </div>
            ) : null}

            <p>
              送出後，你會先成為等待開通成員。等級 1 負責人會再設定你的角色與分校權限。
            </p>
            <button
              className="auth-page-button"
              disabled={
                isSaving ||
                organizationListStatus === "loading" ||
                !selectedOrganizationId
              }
              onClick={handleRequestAccess}
              type="button"
            >
              {status === "joining" ? "送出中..." : "申請加入"}
            </button>
          </section>
        </div>
      </section>
    </main>
  );
}

export default OrganizationSetupPage;

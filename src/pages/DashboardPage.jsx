import { useEffect, useState } from "react";
import { onAuthStateChanged, signOut } from "firebase/auth";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { auth } from "../lib/firebase";
import {
  getRoleLevelLabel,
  loadOrganizationWorkspace,
} from "../lib/orgData";

const modules = [
  {
    id: "daily-ledger",
    title: "每日收支",
    description: "記錄家長付款、退款、教材費、雜支與各分校現金流。",
    permission: "canRecordDailyLedger",
  },
  {
    id: "teacher-payroll",
    title: "老師薪資",
    description: "依分校、期間、課程與發放狀態查看老師薪資紀錄。",
    permission: "canViewPayroll",
  },
  {
    id: "students-programs",
    title: "學生與課程",
    description: "管理家長、學生、科目、報名紀錄與班級名單。",
    permission: "canViewStudents",
    path: "/students-courses",
  },
  {
    id: "branch-transfer",
    title: "分校轉帳",
    description: "把共同支出或付款調整到正確分校，並保留清楚紀錄。",
    permission: "canTransferBetweenBranches",
  },
  {
    id: "team-access",
    title: "團隊權限",
    description: "邀請員工並設定每個人的權限等級與可查看分校。",
    permission: "canManageMembers",
  },
];

const localizedBranches = {
  "school-1": {
    name: "一校",
    shortName: "一",
  },
  "school-2": {
    name: "二校",
    shortName: "二",
  },
  "school-3": {
    name: "三校",
    shortName: "三",
  },
};

function getDisplayName(user) {
  if (user.displayName) {
    return user.displayName;
  }

  if (user.email) {
    return user.email.split("@")[0];
  }

  return "您好";
}

function getBranchName(branch) {
  return localizedBranches[branch.id]?.name || branch.name;
}

function getBranchShortName(branch) {
  return localizedBranches[branch.id]?.shortName || branch.shortName;
}

function getWorkspaceErrorMessage(error) {
  if (error.code === "permission-denied") {
    return "Firestore 拒絕讀取工作區。請先發布 Firestore rules，並確認負責人 email 已設定。";
  }

  if (error.message === "組織尚未建立。") {
    return "組織尚未建立。請先用負責人 email 登入一次。";
  }

  return "帳號已登入，但目前無法載入工作區。請確認 Firestore rules 與專案設定。";
}

function DashboardPage() {
  const navigate = useNavigate();
  const [authStatus, setAuthStatus] = useState(auth ? "checking" : "error");
  const [currentUser, setCurrentUser] = useState(null);
  const [workspace, setWorkspace] = useState(null);
  const [loadError, setLoadError] = useState(
    auth ? "" : "這個版本尚未設定 Firebase。",
  );

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
        setWorkspace(null);
        return;
      }

      setAuthStatus("loading");
      setLoadError("");

      try {
        const loadedWorkspace = await loadOrganizationWorkspace(user);

        if (active) {
          setWorkspace(loadedWorkspace);
          setAuthStatus("ready");
        }
      } catch (error) {
        console.error("Unable to load organization workspace:", error);

        if (active) {
          setLoadError(getWorkspaceErrorMessage(error));
          setAuthStatus("error");
        }
      }
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

  if (authStatus === "signed-out") {
    return <Navigate replace to="/" />;
  }

  if (authStatus === "checking" || authStatus === "loading") {
    return (
      <main className="dashboard-page">
        <div className="dashboard-loading">
          <span className="brand-mark dark" aria-hidden="true">
            AP
          </span>
          <p>正在載入工作區...</p>
        </div>
      </main>
    );
  }

  if (authStatus === "error") {
    return (
      <main className="dashboard-page">
        <header className="dashboard-topbar">
          <Link className="dashboard-brand" to="/">
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
        <section className="dashboard-message-panel">
          <p className="dashboard-kicker">需要設定</p>
          <h1>無法載入工作區</h1>
          <p>{loadError}</p>
        </section>
      </main>
    );
  }

  const member = workspace.member;
  const permissions = member.permissions || {};
  const activeMember = member.status === "active";
  const branchCount = workspace.visibleBranches.length;
  const enabledModules = modules.filter(
    (module) => permissions[module.permission],
  );

  return (
    <main className="dashboard-page">
      <header className="dashboard-topbar">
        <Link className="dashboard-brand" to="/">
          <span className="brand-mark dark" aria-hidden="true">
            AP
          </span>
          <span>Afterschool Pay</span>
        </Link>
        <div className="dashboard-user-row">
          <span className="dashboard-email">{currentUser?.email}</span>
          <button
            className="dashboard-sign-out"
            onClick={handleSignOut}
            type="button"
          >
            登出
          </button>
        </div>
      </header>

      <section className="dashboard-shell" aria-labelledby="dashboard-title">
        {!currentUser?.emailVerified ? (
          <div className="dashboard-banner">
            驗證信已寄出。請到信箱完成 email 驗證。
          </div>
        ) : null}

        <div className="dashboard-hero-row">
          <div>
            <p className="dashboard-kicker">{workspace.organization.name}</p>
            <h1 id="dashboard-title">歡迎，{getDisplayName(currentUser)}</h1>
            <p className="dashboard-subtitle">
              這是第一版登入後的管理後台，先整理分校、每日收支、老師薪資與團隊權限。
            </p>
          </div>
          <span
            className={`member-status ${activeMember ? "active" : "pending"}`}
          >
            {activeMember ? "已開通" : "等待開通"}
          </span>
        </div>

        <div className="dashboard-summary-grid" aria-label="帳號摘要">
          <article className="summary-tile">
            <span>權限等級</span>
            <strong>{getRoleLevelLabel(member.roleLevel)}</strong>
          </article>
          <article className="summary-tile">
            <span>可查看分校</span>
            <strong>{branchCount}</strong>
          </article>
          <article className="summary-tile">
            <span>可使用功能</span>
            <strong>{enabledModules.length}</strong>
          </article>
        </div>

        {!activeMember ? (
          <section className="access-panel">
            <p className="dashboard-kicker">帳號已建立</p>
            <h2>等待負責人開通權限</h2>
            <p>
              你的登入帳號已儲存。負責人設定你的權限等級與可查看分校後，
              這裡會開啟對應的功能。
            </p>
          </section>
        ) : (
          <div className="workspace-grid">
            <aside className="branch-panel" aria-labelledby="branches-title">
              <div className="panel-heading">
                <p className="dashboard-kicker">分校</p>
                <h2 id="branches-title">你可以查看的分校</h2>
              </div>
              <div className="branch-list">
                {workspace.visibleBranches.map((branch) => (
                  <article className="branch-card" key={branch.id}>
                    <span>{getBranchShortName(branch)}</span>
                    <div>
                      <h3>{getBranchName(branch)}</h3>
                      <p>每日收支功能已準備設定</p>
                    </div>
                  </article>
                ))}
              </div>
            </aside>

            <section className="module-panel" aria-labelledby="modules-title">
              <div className="panel-heading">
                <p className="dashboard-kicker">工作區</p>
                <h2 id="modules-title">依權限開放的功能</h2>
              </div>
              <div className="module-grid">
                {modules.map((module) => {
                  const enabled = permissions[module.permission];

                  return (
                    <article
                      className={`module-card ${enabled ? "enabled" : "locked"}`}
                      key={module.id}
                    >
                      <div>
                        <h3>{module.title}</h3>
                        <p>{module.description}</p>
                      </div>
                      {enabled && module.path ? (
                        <Link to={module.path}>開啟</Link>
                      ) : (
                        <span>{enabled ? "可使用" : "未開放"}</span>
                      )}
                    </article>
                  );
                })}
              </div>
            </section>
          </div>
        )}
      </section>
    </main>
  );
}

export default DashboardPage;

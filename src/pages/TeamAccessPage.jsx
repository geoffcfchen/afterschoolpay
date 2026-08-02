import { useEffect, useMemo, useState } from "react";
import { onAuthStateChanged, signOut } from "firebase/auth";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { auth } from "../lib/firebase";
import {
  PERMISSION_DEFINITIONS,
  ROLE_LEVELS,
  getRoleLevelLabel,
  getRolePresetPermissions,
  isOrganizationSetupRequiredError,
  loadOrganizationMembers,
  loadOrganizationWorkspace,
  updateOrganizationMember,
} from "../lib/orgData";

const STATUS_LABELS = {
  active: "已開通",
  pending: "等待開通",
  suspended: "已停用",
};

function getWorkspaceErrorMessage(error) {
  if (error.code === "permission-denied") {
    return "Firestore 拒絕讀取團隊權限。請確認 rules 已發布，且你有團隊權限。";
  }

  return "帳號已登入，但目前無法載入團隊權限。";
}

function makeMemberDraft(member, branches) {
  const roleLevel = Number(member?.roleLevel) || 4;

  return {
    roleLevel,
    status: member?.status || (roleLevel === 4 ? "pending" : "active"),
    branchIds:
      roleLevel === 1
        ? branches.map((branch) => branch.id)
        : [...(member?.branchIds || [])],
    permissions: {
      ...getRolePresetPermissions(roleLevel),
      ...(member?.permissions || {}),
    },
  };
}

function getDisplayName(member) {
  return member.displayName || member.email?.split("@")[0] || "未命名成員";
}

function TeamAccessPage() {
  const navigate = useNavigate();
  const [authStatus, setAuthStatus] = useState(auth ? "checking" : "error");
  const [currentUser, setCurrentUser] = useState(null);
  const [workspace, setWorkspace] = useState(null);
  const [members, setMembers] = useState([]);
  const [selectedMemberId, setSelectedMemberId] = useState("");
  const [draft, setDraft] = useState(null);
  const [loadError, setLoadError] = useState(
    auth ? "" : "這個版本尚未設定 Firebase。",
  );
  const [saveStatus, setSaveStatus] = useState("idle");
  const [saveMessage, setSaveMessage] = useState("");

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
        const loadedMembers =
          loadedWorkspace.member.permissions?.canManageMembers ||
          loadedWorkspace.member.roleLevel === 1
            ? await loadOrganizationMembers(loadedWorkspace.activeOrgId)
            : [];

        if (active) {
          const selectedMember = loadedMembers[0];

          setWorkspace(loadedWorkspace);
          setMembers(loadedMembers);
          setSelectedMemberId(selectedMember?.id || "");
          setDraft(
            selectedMember
              ? makeMemberDraft(selectedMember, loadedWorkspace.branches)
              : null,
          );
          setAuthStatus("ready");
        }
      } catch (error) {
        console.error("Unable to load team access:", error);

        if (active) {
          if (isOrganizationSetupRequiredError(error)) {
            navigate("/organization-setup", { replace: true });
            return;
          }

          setLoadError(getWorkspaceErrorMessage(error));
          setAuthStatus("error");
        }
      }
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [navigate]);

  const canManageMembers =
    workspace?.member?.permissions?.canManageMembers ||
    workspace?.member?.roleLevel === 1;
  const selectedMember = useMemo(
    () => members.find((member) => member.id === selectedMemberId) || null,
    [members, selectedMemberId],
  );
  const activeMembers = members.filter((member) => member.status === "active");
  const pendingMembers = members.filter((member) => member.status !== "active");
  const selectableBranches = workspace?.branches || [];
  const isEditingSelf = selectedMember?.id === currentUser?.uid;

  const handleSignOut = async () => {
    if (!auth) {
      return;
    }

    await signOut(auth);
    navigate("/");
  };

  const selectMember = (member) => {
    setSelectedMemberId(member.id);
    setDraft(makeMemberDraft(member, selectableBranches));
    setSaveStatus("idle");
    setSaveMessage("");
  };

  const handleRoleChange = (event) => {
    const roleLevel = Number(event.target.value);
    const permissions = getRolePresetPermissions(roleLevel);

    setDraft((current) => ({
      ...current,
      roleLevel,
      status: roleLevel === 4 ? "pending" : "active",
      branchIds:
        roleLevel === 1
          ? selectableBranches.map((branch) => branch.id)
          : current.branchIds,
      permissions,
    }));
  };

  const handleStatusChange = (event) => {
    setDraft((current) => ({
      ...current,
      status: event.target.value,
    }));
  };

  const toggleBranch = (branchId) => {
    setDraft((current) => {
      const branchIds = current.branchIds.includes(branchId)
        ? current.branchIds.filter((id) => id !== branchId)
        : [...current.branchIds, branchId];

      return {
        ...current,
        branchIds,
      };
    });
  };

  const togglePermission = (permissionKey) => {
    setDraft((current) => ({
      ...current,
      permissions: {
        ...current.permissions,
        [permissionKey]: !current.permissions[permissionKey],
      },
    }));
  };

  const handleSave = async () => {
    if (!selectedMember || !draft || isEditingSelf) {
      return;
    }

    setSaveStatus("saving");
    setSaveMessage("");

    try {
      await updateOrganizationMember(
        selectedMember.id,
        draft,
        currentUser?.uid,
        workspace.activeOrgId,
      );
      const loadedMembers = await loadOrganizationMembers(workspace.activeOrgId);
      const savedMember =
        loadedMembers.find((member) => member.id === selectedMember.id) ||
        loadedMembers[0];

      setMembers(loadedMembers);
      setSelectedMemberId(savedMember?.id || "");
      setDraft(
        savedMember ? makeMemberDraft(savedMember, selectableBranches) : null,
      );
      setSaveStatus("saved");
      setSaveMessage("團隊權限已儲存。");
    } catch (error) {
      console.error("Unable to save team access:", error);
      setSaveStatus("error");
      setSaveMessage("無法儲存權限。請確認 Firestore rules 與你的帳號權限。");
    }
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
          <p>正在載入團隊權限...</p>
        </div>
      </main>
    );
  }

  if (authStatus === "error") {
    return (
      <main className="dashboard-page">
        <header className="dashboard-topbar">
          <Link className="dashboard-brand" to="/dashboard">
            <span className="brand-mark dark" aria-hidden="true">
              AP
            </span>
            <span>團隊權限</span>
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
          <h1>無法載入團隊權限</h1>
          <p>{loadError}</p>
        </section>
      </main>
    );
  }

  if (!canManageMembers) {
    return (
      <main className="dashboard-page">
        <header className="dashboard-topbar">
          <Link className="dashboard-brand" to="/dashboard">
            <span className="brand-mark dark" aria-hidden="true">
              AP
            </span>
            <span>團隊權限</span>
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
          <p className="dashboard-kicker">權限未開放</p>
          <h1>尚不能管理團隊權限</h1>
          <p>請負責人開通團隊權限後，再回到此頁面。</p>
        </section>
      </main>
    );
  }

  return (
    <main className="dashboard-page">
      <header className="dashboard-topbar">
        <Link className="dashboard-brand" to="/dashboard">
          <span className="brand-mark dark" aria-hidden="true">
            AP
          </span>
          <span>團隊權限</span>
        </Link>
        <div className="dashboard-user-row">
          <Link className="dashboard-text-link" to="/dashboard">
            回管理後台
          </Link>
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

      <section className="team-shell" aria-labelledby="team-title">
        <div className="dashboard-hero-row">
          <div>
            <p className="dashboard-kicker">{workspace.organization.name}</p>
            <h1 id="team-title">團隊權限</h1>
            <p className="dashboard-subtitle">
              一校、二校、三校都屬於同一個組織。人員先登入一次後，
              負責人可以在這裡開通角色、分校範圍與功能權限。
            </p>
          </div>
          <span className="member-status active">等級 1 可管理</span>
        </div>

        <div className="dashboard-summary-grid" aria-label="團隊摘要">
          <article className="summary-tile">
            <span>組織成員</span>
            <strong>{members.length}</strong>
          </article>
          <article className="summary-tile">
            <span>已開通</span>
            <strong>{activeMembers.length}</strong>
          </article>
          <article className="summary-tile">
            <span>等待處理</span>
            <strong>{pendingMembers.length}</strong>
          </article>
        </div>

        <div className="team-workspace-grid">
          <section className="team-list-panel" aria-labelledby="member-list-title">
            <div className="panel-heading">
              <p className="dashboard-kicker">成員</p>
              <h2 id="member-list-title">已登入帳號</h2>
              <p>
                新同事先用 email 或 Google 登入一次，就會以等級 4 出現在這裡。
              </p>
            </div>
            <div className="team-member-list">
              {members.map((member) => (
                <button
                  className={selectedMemberId === member.id ? "active" : ""}
                  key={member.id}
                  onClick={() => selectMember(member)}
                  type="button"
                >
                  <span>{getDisplayName(member).slice(0, 1).toUpperCase()}</span>
                  <div>
                    <strong>{getDisplayName(member)}</strong>
                    <p>{member.email}</p>
                  </div>
                  <em className={`status-chip ${member.status || "pending"}`}>
                    {STATUS_LABELS[member.status] || "等待開通"}
                  </em>
                </button>
              ))}
            </div>
          </section>

          <section className="team-editor-panel" aria-labelledby="member-editor">
            {selectedMember && draft ? (
              <>
                <div className="panel-heading">
                  <p className="dashboard-kicker">權限設定</p>
                  <h2 id="member-editor">{getDisplayName(selectedMember)}</h2>
                  <p>{selectedMember.email}</p>
                </div>

                {isEditingSelf ? (
                  <div className="dashboard-banner">
                    你正在查看自己的帳號。為了避免把唯一負責人鎖在外面，這裡不允許修改自己。
                  </div>
                ) : null}

                <div className="team-editor-grid">
                  <label>
                    權限等級
                    <select
                      disabled={isEditingSelf}
                      onChange={handleRoleChange}
                      value={draft.roleLevel}
                    >
                      {Object.entries(ROLE_LEVELS).map(([level, label]) => (
                        <option key={level} value={level}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    帳號狀態
                    <select
                      disabled={isEditingSelf || draft.roleLevel === 4}
                      onChange={handleStatusChange}
                      value={draft.status}
                    >
                      <option value="active">已開通</option>
                      <option value="suspended">已停用</option>
                      <option value="pending">等待開通</option>
                    </select>
                  </label>
                </div>

                <section className="permission-section">
                  <div className="panel-heading">
                    <p className="dashboard-kicker">可查看分校</p>
                    <h2>分校範圍</h2>
                  </div>
                  <div className="branch-permission-grid">
                    {selectableBranches.map((branch) => (
                      <label key={branch.id}>
                        <input
                          checked={draft.branchIds.includes(branch.id)}
                          disabled={isEditingSelf || draft.roleLevel === 1}
                          onChange={() => toggleBranch(branch.id)}
                          type="checkbox"
                        />
                        <span>{branch.name}</span>
                      </label>
                    ))}
                  </div>
                </section>

                <section className="permission-section">
                  <div className="panel-heading">
                    <p className="dashboard-kicker">功能權限</p>
                    <h2>平台功能</h2>
                  </div>
                  <div className="permission-grid">
                    {PERMISSION_DEFINITIONS.map((permission) => (
                      <label key={permission.key}>
                        <input
                          checked={Boolean(draft.permissions[permission.key])}
                          disabled={isEditingSelf || draft.roleLevel === 1}
                          onChange={() => togglePermission(permission.key)}
                          type="checkbox"
                        />
                        <span>
                          <strong>{permission.label}</strong>
                          <em>{permission.description}</em>
                        </span>
                      </label>
                    ))}
                  </div>
                </section>

                <div className="team-save-row">
                  <button
                    className="confirm-import-button"
                    disabled={isEditingSelf || saveStatus === "saving"}
                    onClick={handleSave}
                    type="button"
                  >
                    {saveStatus === "saving" ? "儲存中..." : "儲存權限"}
                  </button>
                  <span>
                    {saveMessage ||
                      `${getRoleLevelLabel(draft.roleLevel)} / ${
                        STATUS_LABELS[draft.status] || "等待開通"
                      }`}
                  </span>
                </div>
              </>
            ) : (
              <div className="dashboard-message-panel inline">
                <p className="dashboard-kicker">尚無成員</p>
                <h1>等待同事登入</h1>
                <p>有人登入後，會出現在這裡讓負責人開通。</p>
              </div>
            )}
          </section>
        </div>
      </section>
    </main>
  );
}

export default TeamAccessPage;

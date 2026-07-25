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
    title: "Daily income and expense",
    description:
      "Record family payments, refunds, supplies, and school-site cash movement.",
    permission: "canRecordDailyLedger",
  },
  {
    id: "teacher-payroll",
    title: "Teacher payroll",
    description:
      "Review teacher salary records by branch, period, class, and payout status.",
    permission: "canViewPayroll",
  },
  {
    id: "students-programs",
    title: "Students and programs",
    description:
      "Keep families, students, subjects, enrollment, and class rosters together.",
    permission: "canViewStudents",
  },
  {
    id: "branch-transfer",
    title: "Branch transfer",
    description:
      "Move shared costs or payments from one school site to another with a clear trail.",
    permission: "canTransferBetweenBranches",
  },
  {
    id: "team-access",
    title: "Team access",
    description:
      "Invite staff and control which permission level each person receives.",
    permission: "canManageMembers",
  },
];

function getDisplayName(user) {
  if (user.displayName) {
    return user.displayName;
  }

  if (user.email) {
    return user.email.split("@")[0];
  }

  return "there";
}

function getWorkspaceErrorMessage(error) {
  if (error.code === "permission-denied") {
    return "Firestore rejected the workspace request. Publish the starter Firestore rules and confirm your owner email is set.";
  }

  if (error.message === "The organization has not been created yet.") {
    return "The organization has not been created yet. Sign in once with the bootstrap owner email first.";
  }

  return "Your account is signed in, but the workspace could not load yet. Check Firestore rules and setup.";
}

function DashboardPage() {
  const navigate = useNavigate();
  const [authStatus, setAuthStatus] = useState(auth ? "checking" : "error");
  const [currentUser, setCurrentUser] = useState(null);
  const [workspace, setWorkspace] = useState(null);
  const [loadError, setLoadError] = useState(
    auth ? "" : "Firebase is not configured for this build.",
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
          <p>Loading your workspace...</p>
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
            Log out
          </button>
        </header>
        <section className="dashboard-message-panel">
          <p className="dashboard-kicker">Setup needed</p>
          <h1>Workspace could not load</h1>
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
            Log out
          </button>
        </div>
      </header>

      <section className="dashboard-shell" aria-labelledby="dashboard-title">
        {!currentUser?.emailVerified ? (
          <div className="dashboard-banner">
            Your verification email was sent. Confirm your email when you can.
          </div>
        ) : null}

        <div className="dashboard-hero-row">
          <div>
            <p className="dashboard-kicker">{workspace.organization.name}</p>
            <h1 id="dashboard-title">Welcome, {getDisplayName(currentUser)}</h1>
            <p className="dashboard-subtitle">
              This is the first logged-in workspace for branches, daily records,
              teacher payroll, and team permissions.
            </p>
          </div>
          <span
            className={`member-status ${activeMember ? "active" : "pending"}`}
          >
            {activeMember ? "Active access" : "Waiting for access"}
          </span>
        </div>

        <div className="dashboard-summary-grid" aria-label="Account summary">
          <article className="summary-tile">
            <span>Permission level</span>
            <strong>{getRoleLevelLabel(member.roleLevel)}</strong>
          </article>
          <article className="summary-tile">
            <span>Visible school sites</span>
            <strong>{branchCount}</strong>
          </article>
          <article className="summary-tile">
            <span>Available modules</span>
            <strong>{enabledModules.length}</strong>
          </article>
        </div>

        {!activeMember ? (
          <section className="access-panel">
            <p className="dashboard-kicker">Account created</p>
            <h2>Waiting for an owner to approve access</h2>
            <p>
              Your login is saved. Once an owner assigns your permission level
              and school sites, this page will open the tools for your role.
            </p>
          </section>
        ) : (
          <div className="workspace-grid">
            <aside className="branch-panel" aria-labelledby="branches-title">
              <div className="panel-heading">
                <p className="dashboard-kicker">School sites</p>
                <h2 id="branches-title">Branches you can see</h2>
              </div>
              <div className="branch-list">
                {workspace.visibleBranches.map((branch) => (
                  <article className="branch-card" key={branch.id}>
                    <span>{branch.shortName}</span>
                    <div>
                      <h3>{branch.name}</h3>
                      <p>Daily income and expense ready for setup</p>
                    </div>
                  </article>
                ))}
              </div>
            </aside>

            <section className="module-panel" aria-labelledby="modules-title">
              <div className="panel-heading">
                <p className="dashboard-kicker">Workspace</p>
                <h2 id="modules-title">Tools for your role</h2>
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
                      <span>{enabled ? "Available" : "Locked"}</span>
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

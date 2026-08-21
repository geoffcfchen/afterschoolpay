import { useEffect, useMemo, useState } from "react";
import { onAuthStateChanged, signOut } from "firebase/auth";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { auth } from "../lib/firebase";
import {
  isDisplayNameSetupRequiredError,
  isOrganizationSetupRequiredError,
  loadOrganizationWorkspace,
} from "../lib/orgData";
import {
  PAYROLL_TYPE_LABELS,
  calculateEightLessonTotal,
  calculateSalaryClassTotal,
  calculateSalarySessionAmount,
  createSalaryClassDraft,
  createTeacherEmployee,
  getPayrollTypeLabel,
  getSalarySlipStatusLabel,
  saveTeacherSalarySlip,
  subscribeEmployeeSalarySlips,
  subscribeOrganizationEmployees,
} from "../lib/teacherPayrollData";

const PAYROLL_TYPE_OPTIONS = [
  { value: "monthly", label: PAYROLL_TYPE_LABELS.monthly },
  { value: "eightLessons", label: PAYROLL_TYPE_LABELS.eightLessons },
];

function getWorkspaceErrorMessage(error) {
  if (error.code === "permission-denied") {
    return "Firestore 拒絕讀取老師薪資。請確認 Firestore rules 與你的權限。";
  }

  return "帳號已登入，但目前無法載入老師薪資工作台。";
}

function formatCurrency(amount) {
  const value = Number(amount) || 0;

  return `NT$${value.toLocaleString()}`;
}

function formatDate(value) {
  if (!value) {
    return "未設定";
  }

  const date =
    typeof value?.toDate === "function" ? value.toDate() : new Date(value);

  if (Number.isNaN(date.getTime())) {
    return String(value);
  }

  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
}

function todayDateValue() {
  return new Date().toISOString().slice(0, 10);
}

function currentMonthValue() {
  return new Date().toISOString().slice(0, 7);
}

function createAdditionalSalaryItem() {
  const id = globalThis.crypto?.randomUUID
    ? `additional-salary-${globalThis.crypto.randomUUID()}`
    : `additional-salary-${Date.now().toString(36)}-${Math.random()
        .toString(36)
        .slice(2, 8)}`;

  return {
    amount: "",
    id,
    reason: "",
  };
}

function employeeBelongsToBranch(employee, branchId) {
  const branchIds = Array.isArray(employee?.branchIds) ? employee.branchIds : [];

  return branchIds.includes(branchId);
}

function sortSlipsByDate(records) {
  return [...records].sort((first, second) =>
    String(second.issuedAtIso || "").localeCompare(String(first.issuedAtIso || "")),
  );
}

function TeacherPayrollPage() {
  const navigate = useNavigate();
  const [authStatus, setAuthStatus] = useState(auth ? "checking" : "error");
  const [currentUser, setCurrentUser] = useState(null);
  const [workspace, setWorkspace] = useState(null);
  const [loadError, setLoadError] = useState(
    auth ? "" : "這個版本尚未設定 Firebase。",
  );
  const [activeBranchId, setActiveBranchId] = useState("");
  const [employees, setEmployees] = useState([]);
  const [employeeLoadStatus, setEmployeeLoadStatus] = useState("idle");
  const [employeeLoadError, setEmployeeLoadError] = useState("");
  const [selectedEmployeeId, setSelectedEmployeeId] = useState("");
  const [employeeForm, setEmployeeForm] = useState({
    compensationType: "monthly",
    name: "",
  });
  const [employeeSaveStatus, setEmployeeSaveStatus] = useState("idle");
  const [employeeSaveError, setEmployeeSaveError] = useState("");
  const [payrollType, setPayrollType] = useState("");
  const [monthlyForm, setMonthlyForm] = useState({
    amount: "",
    salaryDate: todayDateValue(),
    salaryMonth: currentMonthValue(),
  });
  const [additionalSalaryItems, setAdditionalSalaryItems] = useState([]);
  const [salaryClasses, setSalaryClasses] = useState([
    createSalaryClassDraft(),
  ]);
  const [salarySlips, setSalarySlips] = useState([]);
  const [salarySlipLoadStatus, setSalarySlipLoadStatus] = useState("idle");
  const [salarySlipLoadError, setSalarySlipLoadError] = useState("");
  const [salarySlipSaveStatus, setSalarySlipSaveStatus] = useState("idle");
  const [salarySlipMessage, setSalarySlipMessage] = useState("");
  const [lastGeneratedSalarySlipId, setLastGeneratedSalarySlipId] = useState("");

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
          setActiveBranchId((currentBranchId) =>
            loadedWorkspace.visibleBranches.some(
              (branch) => branch.id === currentBranchId,
            )
              ? currentBranchId
              : loadedWorkspace.visibleBranches[0]?.id || "",
          );
          setAuthStatus("ready");
        }
      } catch (error) {
        console.error("Unable to load teacher payroll workspace:", error);

        if (active) {
          if (isDisplayNameSetupRequiredError(error)) {
            navigate("/profile-setup?next=/teacher-payroll", {
              replace: true,
            });
            return;
          }

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

  const canViewPayroll =
    workspace?.member?.roleLevel === 1 ||
    workspace?.member?.permissions?.canViewPayroll;
  const branchOptions = workspace?.visibleBranches || [];
  const selectedBranch =
    branchOptions.find((branch) => branch.id === activeBranchId) ||
    branchOptions[0] ||
    null;
  const canViewAllBranches =
    workspace?.member?.roleLevel === 1 ||
    workspace?.member?.permissions?.canViewAllBranches;
  const allowedBranchKey = branchOptions.map((branch) => branch.id).join("|");

  useEffect(() => {
    if (authStatus !== "ready" || !canViewPayroll || !workspace?.activeOrgId) {
      return undefined;
    }

    let active = true;
    let unsubscribe = () => {};

    Promise.resolve().then(() => {
      if (!active) {
        return;
      }

      setEmployeeLoadStatus("loading");
      setEmployeeLoadError("");

      try {
        unsubscribe = subscribeOrganizationEmployees({
          branchIds: allowedBranchKey
            ? allowedBranchKey.split("|").filter(Boolean)
            : [],
          canViewAllBranches,
          onChange: (records) => {
            if (!active) {
              return;
            }

            setEmployees(records);
            setEmployeeLoadStatus("ready");
          },
          onError: (error) => {
            console.error("Unable to listen to employees:", error);

            if (!active) {
              return;
            }

            setEmployees([]);
            setEmployeeLoadStatus("error");
            setEmployeeLoadError("無法載入老師名單。請確認 Firestore 權限。");
          },
          orgId: workspace.activeOrgId,
        });
      } catch (error) {
        console.error("Unable to start employee listener:", error);

        if (!active) {
          return;
        }

        setEmployees([]);
        setEmployeeLoadStatus("error");
        setEmployeeLoadError("無法啟動老師名單同步。請確認 Firebase 設定。");
      }
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [
    allowedBranchKey,
    authStatus,
    canViewAllBranches,
    canViewPayroll,
    workspace?.activeOrgId,
  ]);

  const branchEmployees = useMemo(
    () =>
      employees.filter((employee) => employeeBelongsToBranch(employee, activeBranchId)),
    [activeBranchId, employees],
  );

  const selectedEmployee = useMemo(
    () =>
      branchEmployees.find((employee) => employee.id === selectedEmployeeId) ||
      branchEmployees[0] ||
      null,
    [branchEmployees, selectedEmployeeId],
  );
  const activePayrollType =
    payrollType ||
    (selectedEmployee?.compensationType === "eightLessons"
      ? "eightLessons"
      : "monthly");

  useEffect(() => {
    let active = true;
    let unsubscribe = () => {};

    Promise.resolve().then(() => {
      if (!active) {
        return;
      }

      if (!workspace?.activeOrgId || !selectedEmployee?.id) {
        setSalarySlips([]);
        setSalarySlipLoadStatus("idle");
        setSalarySlipLoadError("");
        return;
      }

      setSalarySlips([]);
      setSalarySlipLoadStatus("loading");
      setSalarySlipLoadError("");

      unsubscribe = subscribeEmployeeSalarySlips({
        employeeId: selectedEmployee.id,
        onChange: (records) => {
          if (!active) {
            return;
          }

          setSalarySlips(records);
          setSalarySlipLoadStatus("ready");
        },
        onError: (error) => {
          console.error("Unable to listen to salary slips:", error);

          if (!active) {
            return;
          }

          setSalarySlips([]);
          setSalarySlipLoadStatus("error");
          setSalarySlipLoadError("無法載入此老師的薪資單。");
        },
        orgId: workspace.activeOrgId,
      });
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [selectedEmployee?.id, workspace?.activeOrgId]);

  const branchSalarySlips = useMemo(
    () =>
      sortSlipsByDate(
        salarySlips.filter((slip) => slip.branchId === activeBranchId),
      ),
    [activeBranchId, salarySlips],
  );

  const eightLessonTotal = useMemo(
    () => calculateEightLessonTotal(salaryClasses),
    [salaryClasses],
  );
  const monthlyTotal = Number(monthlyForm.amount) || 0;
  const additionalSalaryTotal = useMemo(
    () =>
      additionalSalaryItems.reduce(
        (total, item) => total + (Number(item.amount) || 0),
        0,
      ),
    [additionalSalaryItems],
  );
  const monthlyGrandTotal = monthlyTotal + additionalSalaryTotal;
  const eightLessonGrandTotal = eightLessonTotal + additionalSalaryTotal;
  const salarySlipTotal =
    activePayrollType === "monthly"
      ? monthlyGrandTotal
      : eightLessonGrandTotal;
  const unpaidSalaryTotal = branchSalarySlips
    .filter((slip) => slip.status === "unpaid")
    .reduce((total, slip) => total + (Number(slip.balance ?? slip.total) || 0), 0);

  const handleSignOut = async () => {
    if (!auth) {
      return;
    }

    await signOut(auth);
    navigate("/");
  };

  const handleCreateEmployee = async (event) => {
    event.preventDefault();

    if (!selectedBranch || employeeSaveStatus === "saving") {
      return;
    }

    setEmployeeSaveStatus("saving");
    setEmployeeSaveError("");

    try {
      const employee = await createTeacherEmployee({
        branch: selectedBranch,
        compensationType: employeeForm.compensationType,
        createdByUid: currentUser?.uid || "",
        name: employeeForm.name,
        orgId: workspace.activeOrgId,
      });

      setEmployeeForm({
        compensationType: employeeForm.compensationType,
        name: "",
      });
      setSelectedEmployeeId(employee.id);
      setPayrollType(employee.compensationType);
      setEmployeeSaveStatus("idle");
    } catch (error) {
      console.error("Unable to create teacher employee:", error);
      setEmployeeSaveError(error.message || "無法新增老師。");
      setEmployeeSaveStatus("error");
    }
  };

  const handleMonthlyFormChange = (event) => {
    const { name, value } = event.target;

    setMonthlyForm((current) => ({
      ...current,
      [name]: value,
    }));
  };

  const addAdditionalSalaryItem = () => {
    setAdditionalSalaryItems((current) => [
      ...current,
      createAdditionalSalaryItem(),
    ]);
  };

  const updateAdditionalSalaryItem = (itemId, changes) => {
    setAdditionalSalaryItems((current) =>
      current.map((item) =>
        item.id === itemId ? { ...item, ...changes } : item,
      ),
    );
  };

  const removeAdditionalSalaryItem = (itemId) => {
    setAdditionalSalaryItems((current) =>
      current.filter((item) => item.id !== itemId),
    );
  };

  const updateSalaryClass = (classId, changes) => {
    setSalaryClasses((current) =>
      current.map((classDraft) =>
        classDraft.id === classId ? { ...classDraft, ...changes } : classDraft,
      ),
    );
  };

  const updateSalarySession = (classId, sessionId, changes) => {
    setSalaryClasses((current) =>
      current.map((classDraft) =>
        classDraft.id === classId
          ? {
              ...classDraft,
              sessions: classDraft.sessions.map((session) =>
                session.id === sessionId ? { ...session, ...changes } : session,
              ),
            }
          : classDraft,
      ),
    );
  };

  const addSalaryClass = () => {
    setSalaryClasses((current) => [...current, createSalaryClassDraft()]);
  };

  const removeSalaryClass = (classId) => {
    setSalaryClasses((current) => {
      const nextClasses = current.filter((classDraft) => classDraft.id !== classId);

      return nextClasses.length ? nextClasses : [createSalaryClassDraft()];
    });
  };

  const handleGenerateSalarySlip = async (event) => {
    event.preventDefault();

    if (
      !selectedEmployee ||
      !selectedBranch ||
      !workspace?.activeOrgId ||
      salarySlipSaveStatus === "saving"
    ) {
      return;
    }

    setSalarySlipSaveStatus("saving");
    setSalarySlipMessage("");

    try {
      const saved = await saveTeacherSalarySlip({
        additionalSalaryItems,
        branch: selectedBranch,
        classDrafts: salaryClasses,
        employee: selectedEmployee,
        generatedByEmail: currentUser?.email || "",
        generatedByUid: currentUser?.uid || "",
        monthlyAmount: monthlyForm.amount,
        organization: workspace.organization,
        orgId: workspace.activeOrgId,
        payrollType: activePayrollType,
        salaryDate: monthlyForm.salaryDate,
        salaryMonth: monthlyForm.salaryMonth,
      });

      setLastGeneratedSalarySlipId(saved.salarySlipId);
      setSalarySlipMessage(`已產生 ${saved.salarySlipNumber}。`);
      setSalarySlipSaveStatus("saved");

      if (activePayrollType === "eightLessons") {
        setSalaryClasses([createSalaryClassDraft()]);
      } else {
        setMonthlyForm((current) => ({
          ...current,
          amount: "",
        }));
      }
      setAdditionalSalaryItems([]);
    } catch (error) {
      console.error("Unable to save teacher salary slip:", error);
      setSalarySlipMessage(error.message || "無法產生老師薪資單。");
      setSalarySlipSaveStatus("error");
    }
  };

  const renderAdditionalSalaryPanel = ({ baseLabel, baseTotal }) => {
    const titleId = `additional-salary-title-${activePayrollType}`;

    return (
      <section
        className="monthly-additional-panel"
        aria-labelledby={titleId}
      >
        <div className="monthly-additional-heading">
          <div>
            <h3 id={titleId}>額外薪資</h3>
            <p>可新增多筆加給、補薪、代課或其他原因。</p>
          </div>
          <button
            className="table-panel-action-button secondary-table-action"
            onClick={addAdditionalSalaryItem}
            type="button"
          >
            新增額外薪資
          </button>
        </div>

        {additionalSalaryItems.length ? (
          <div className="monthly-additional-list">
            {additionalSalaryItems.map((item, index) => (
              <div className="monthly-additional-row" key={item.id}>
                <label>
                  原因
                  <input
                    onChange={(event) =>
                      updateAdditionalSalaryItem(item.id, {
                        reason: event.target.value,
                      })
                    }
                    placeholder={`額外薪資 ${index + 1} 原因`}
                    value={item.reason}
                  />
                </label>
                <label>
                  金額
                  <input
                    onChange={(event) =>
                      updateAdditionalSalaryItem(item.id, {
                        amount: event.target.value,
                      })
                    }
                    placeholder="例如：1200"
                    type="number"
                    value={item.amount}
                  />
                </label>
                <button
                  className="secondary-modal-button"
                  onClick={() => removeAdditionalSalaryItem(item.id)}
                  type="button"
                >
                  移除
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p className="ledger-state-note">沒有額外薪資項目。</p>
        )}

        <div className="monthly-salary-breakdown">
          <span>
            {baseLabel}
            <strong>{formatCurrency(baseTotal)}</strong>
          </span>
          <span>
            額外薪資
            <strong>{formatCurrency(additionalSalaryTotal)}</strong>
          </span>
        </div>
      </section>
    );
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
          <p>正在載入老師薪資...</p>
        </div>
      </main>
    );
  }

  if (authStatus === "error") {
    return (
      <main className="dashboard-page">
        <header className="dashboard-topbar no-print">
          <Link className="dashboard-brand" to="/dashboard">
            <span className="brand-mark dark" aria-hidden="true">
              AP
            </span>
            <span>老師薪資</span>
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
          <h1>無法載入老師薪資</h1>
          <p>{loadError}</p>
        </section>
      </main>
    );
  }

  if (!canViewPayroll) {
    return (
      <main className="dashboard-page">
        <header className="dashboard-topbar no-print">
          <Link className="dashboard-brand" to="/dashboard">
            <span className="brand-mark dark" aria-hidden="true">
              AP
            </span>
            <span>老師薪資</span>
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
          <h1>尚不能使用老師薪資</h1>
          <p>請負責人開通老師薪資權限後，再建立與查看老師薪資單。</p>
        </section>
      </main>
    );
  }

  return (
    <main className="dashboard-page">
      <header className="dashboard-topbar no-print">
        <Link className="dashboard-brand" to="/dashboard">
          <span className="brand-mark dark" aria-hidden="true">
            AP
          </span>
          <span>老師薪資</span>
        </Link>
        <div className="dashboard-user-row">
          <Link className="dashboard-text-link" to="/daily-ledger">
            每日收支
          </Link>
          <span className="dashboard-email">
            {workspace.profile?.displayName ||
              currentUser?.displayName ||
              currentUser?.email}
          </span>
          <Link
            className="dashboard-text-link"
            to="/profile-setup?edit=1&next=/teacher-payroll"
          >
            修改姓名
          </Link>
          <button
            className="dashboard-sign-out"
            onClick={handleSignOut}
            type="button"
          >
            登出
          </button>
        </div>
      </header>

      <section className="payroll-shell" aria-labelledby="payroll-title">
        <div className="import-hero ledger-hero">
          <div>
            <p className="dashboard-kicker">應付款</p>
            <h1 id="payroll-title">老師薪資</h1>
            <p>
              建立老師資料與薪資單；發放狀態、列印與每日帳務會集中到每日收支。
            </p>
          </div>
          <span>{workspace.organization.name}</span>
        </div>

        <section className="branch-workspace-panel" aria-labelledby="payroll-branch-title">
          <div>
            <p className="dashboard-kicker">分校</p>
            <h2 id="payroll-branch-title">
              {selectedBranch ? selectedBranch.name : "請選擇分校"}
            </h2>
            <p>先選分校，再建立該分校的老師薪資單。</p>
          </div>
          <div className="branch-switch-row" aria-label="選擇分校">
            {branchOptions.map((branch) => (
              <button
                aria-pressed={selectedBranch?.id === branch.id}
                className={selectedBranch?.id === branch.id ? "active" : ""}
                key={branch.id}
                onClick={() => {
                  setActiveBranchId(branch.id);
                  setSelectedEmployeeId("");
                  setPayrollType("");
                  setSalarySlipMessage("");
                }}
                type="button"
              >
                {branch.name}
              </button>
            ))}
          </div>
        </section>

        {!selectedBranch ? (
          <section className="dashboard-message-panel inline branch-empty-panel">
            <p className="dashboard-kicker">尚無分校</p>
            <h1>先建立分校</h1>
            <p>建立分校後，這裡會顯示老師薪資工作台。</p>
          </section>
        ) : null}

        {selectedBranch ? (
          <section className="payroll-workspace-grid" aria-label="老師薪資工作台">
            <aside className="ledger-student-panel">
              <div className="panel-heading ledger-panel-heading">
                <div>
                  <p className="dashboard-kicker">老師</p>
                  <h2>{selectedBranch.name}</h2>
                </div>
                <span>{branchEmployees.length}</span>
              </div>

              <form className="employee-create-form" onSubmit={handleCreateEmployee}>
                <label>
                  老師姓名
                  <input
                    onChange={(event) =>
                      setEmployeeForm((current) => ({
                        ...current,
                        name: event.target.value,
                      }))
                    }
                    placeholder="新增老師"
                    value={employeeForm.name}
                  />
                </label>
                <label>
                  計薪方式
                  <select
                    onChange={(event) =>
                      setEmployeeForm((current) => ({
                        ...current,
                        compensationType: event.target.value,
                      }))
                    }
                    value={employeeForm.compensationType}
                  >
                    {PAYROLL_TYPE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <button disabled={employeeSaveStatus === "saving"} type="submit">
                  {employeeSaveStatus === "saving" ? "新增中..." : "新增老師"}
                </button>
              </form>

              {employeeSaveError ? (
                <p className="ledger-state-note error">{employeeSaveError}</p>
              ) : null}

              {employeeLoadStatus === "loading" ? (
                <p className="ledger-state-note">正在載入老師名單...</p>
              ) : null}

              {employeeLoadStatus === "error" ? (
                <p className="ledger-state-note error">{employeeLoadError}</p>
              ) : null}

              {employeeLoadStatus === "ready" && !branchEmployees.length ? (
                <p className="ledger-state-note">目前還沒有老師。</p>
              ) : null}

              <div className="ledger-student-list employee-list">
                {branchEmployees.map((employee) => {
                  const active = selectedEmployee?.id === employee.id;

                  return (
                    <button
                      aria-pressed={active}
                      className={`ledger-student-card employee-card ${
                        active ? "active" : ""
                      }`}
                      key={employee.id}
                      onClick={() => {
                        setSelectedEmployeeId(employee.id);
                        setPayrollType("");
                        setSalarySlipMessage("");
                      }}
                      type="button"
                    >
                      <span>{getPayrollTypeLabel(employee.compensationType)}</span>
                      <div>
                        <strong>{employee.name || "未命名老師"}</strong>
                        <small>{employee.status === "active" ? "在職" : "停用"}</small>
                      </div>
                    </button>
                  );
                })}
              </div>
            </aside>

            <section className="ledger-profile-panel payroll-builder-panel">
              {selectedEmployee ? (
                <>
                  <div className="ledger-profile-heading">
                    <div>
                      <p className="dashboard-kicker">薪資單</p>
                      <h2>{selectedEmployee.name}</h2>
                      <div className="ledger-class-badge-row">
                        <span>{selectedBranch.name}</span>
                        <span>{getPayrollTypeLabel(activePayrollType)}</span>
                      </div>
                    </div>
                    <em className="ledger-student-id-badge">
                      {branchSalarySlips.length} 張薪資單
                    </em>
                  </div>

                  <div className="ledger-summary-grid" aria-label="薪資摘要">
                    <article>
                      <span>本張金額</span>
                      <strong>{formatCurrency(salarySlipTotal)}</strong>
                    </article>
                    <article>
                      <span>未發放</span>
                      <strong>{formatCurrency(unpaidSalaryTotal)}</strong>
                    </article>
                    <article>
                      <span>薪資單</span>
                      <strong>{branchSalarySlips.length}</strong>
                    </article>
                  </div>

                  <form className="salary-slip-form" onSubmit={handleGenerateSalarySlip}>
                    <div className="payroll-mode-toggle" aria-label="計薪方式">
                      {PAYROLL_TYPE_OPTIONS.map((option) => (
                        <button
                          aria-pressed={activePayrollType === option.value}
                          className={
                            activePayrollType === option.value ? "active" : ""
                          }
                          key={option.value}
                          onClick={() => setPayrollType(option.value)}
                          type="button"
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>

                    {activePayrollType === "monthly" ? (
                      <div className="monthly-salary-panel">
                        <div className="salary-form-grid">
                          <label>
                            月份
                            <input
                              name="salaryMonth"
                              onChange={handleMonthlyFormChange}
                              type="month"
                              value={monthlyForm.salaryMonth}
                            />
                          </label>
                          <label>
                            發薪日期
                            <input
                              name="salaryDate"
                              onChange={handleMonthlyFormChange}
                              type="date"
                              value={monthlyForm.salaryDate}
                            />
                          </label>
                          <label>
                            基本月薪
                            <input
                              min="0"
                              name="amount"
                              onChange={handleMonthlyFormChange}
                              placeholder="例如：38000"
                              type="number"
                              value={monthlyForm.amount}
                            />
                          </label>
                        </div>

                        {renderAdditionalSalaryPanel({
                          baseLabel: "基本月薪",
                          baseTotal: monthlyTotal,
                        })}
                      </div>
                    ) : (
                      <div className="salary-class-list">
                        {salaryClasses.map((classDraft, classIndex) => (
                          <article className="salary-class-card" key={classDraft.id}>
                            <div className="salary-class-heading">
                              <label>
                                課程名稱
                                <input
                                  onChange={(event) =>
                                    updateSalaryClass(classDraft.id, {
                                      className: event.target.value,
                                    })
                                  }
                                  placeholder={`課程 ${classIndex + 1}`}
                                  value={classDraft.className}
                                />
                              </label>
                              <div>
                                <strong>
                                  {formatCurrency(
                                    calculateSalaryClassTotal(classDraft),
                                  )}
                                </strong>
                                <button
                                  className="secondary-modal-button"
                                  onClick={() => removeSalaryClass(classDraft.id)}
                                  type="button"
                                >
                                  移除
                                </button>
                              </div>
                            </div>

                            <div className="salary-session-table-wrap">
                              <table className="salary-session-table">
                                <thead>
                                  <tr>
                                    <th>堂次</th>
                                    <th>日期</th>
                                    <th>時薪</th>
                                    <th>時數</th>
                                    <th>小計</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {classDraft.sessions.map((session, sessionIndex) => (
                                    <tr key={session.id}>
                                      <td>{sessionIndex + 1}</td>
                                      <td>
                                        <input
                                          onChange={(event) =>
                                            updateSalarySession(
                                              classDraft.id,
                                              session.id,
                                              { date: event.target.value },
                                            )
                                          }
                                          type="date"
                                          value={session.date}
                                        />
                                      </td>
                                      <td>
                                        <input
                                          min="0"
                                          onChange={(event) =>
                                            updateSalarySession(
                                              classDraft.id,
                                              session.id,
                                              { hourlyRate: event.target.value },
                                            )
                                          }
                                          placeholder="0"
                                          type="number"
                                          value={session.hourlyRate}
                                        />
                                      </td>
                                      <td>
                                        <input
                                          min="0"
                                          onChange={(event) =>
                                            updateSalarySession(
                                              classDraft.id,
                                              session.id,
                                              { hours: event.target.value },
                                            )
                                          }
                                          placeholder="0"
                                          step="0.5"
                                          type="number"
                                          value={session.hours}
                                        />
                                      </td>
                                      <td>
                                        <strong>
                                          {formatCurrency(
                                            calculateSalarySessionAmount(session),
                                          )}
                                        </strong>
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </article>
                        ))}
                        <button
                          className="table-panel-action-button secondary-table-action"
                          onClick={addSalaryClass}
                          type="button"
                        >
                          新增課程
                        </button>
                        {renderAdditionalSalaryPanel({
                          baseLabel: "8堂課小計",
                          baseTotal: eightLessonTotal,
                        })}
                      </div>
                    )}

                    {salarySlipMessage ? (
                      <p
                        className={`ledger-state-note ${
                          salarySlipSaveStatus === "error" ? "error" : "success"
                        }`}
                      >
                        {salarySlipMessage}
                      </p>
                    ) : null}

                    <div className="salary-slip-total-row">
                      <span>薪資單合計</span>
                      <strong>{formatCurrency(salarySlipTotal)}</strong>
                      <button
                        disabled={
                          salarySlipSaveStatus === "saving" || salarySlipTotal <= 0
                        }
                        type="submit"
                      >
                        {salarySlipSaveStatus === "saving"
                          ? "產生中..."
                          : "產生老師薪資單"}
                      </button>
                    </div>
                  </form>

                  <section className="student-invoice-history payroll-history">
                    <div className="student-invoice-history-heading">
                      <div>
                        <h3>已產生的老師薪資單</h3>
                        <p>{selectedBranch.name}</p>
                      </div>
                      <span>{branchSalarySlips.length}</span>
                    </div>

                    {salarySlipLoadStatus === "loading" ? (
                      <p className="invoice-history-state">正在載入薪資單...</p>
                    ) : null}

                    {salarySlipLoadStatus === "error" ? (
                      <p className="invoice-history-state error">
                        {salarySlipLoadError}
                      </p>
                    ) : null}

                    {salarySlipLoadStatus === "ready" &&
                    !branchSalarySlips.length ? (
                      <p className="invoice-history-state">
                        此老師目前沒有薪資單。
                      </p>
                    ) : null}

                    <div className="student-invoice-history-list">
                      {branchSalarySlips.map((slip) => (
                        <article
                          className={
                            slip.id === lastGeneratedSalarySlipId
                              ? "student-invoice-history-item latest"
                              : "student-invoice-history-item"
                          }
                          key={slip.id}
                        >
                          <div>
                            <strong>{slip.salarySlipNumber || slip.id}</strong>
                            <span>
                              {getPayrollTypeLabel(slip.payrollType)} ·{" "}
                              {formatDate(slip.issuedAtIso)}
                            </span>
                          </div>
                          <div>
                            <em className={`invoice-status-chip ${slip.status || "unpaid"}`}>
                              {getSalarySlipStatusLabel(slip.status)}
                            </em>
                            <strong>{formatCurrency(slip.total)}</strong>
                          </div>
                        </article>
                      ))}
                    </div>
                  </section>
                </>
              ) : (
                <div className="ledger-empty-profile">
                  <p className="dashboard-kicker">薪資單</p>
                  <h2>尚未選擇老師</h2>
                  <p>新增或選擇老師後，就可以建立月薪或 8 堂課薪資單。</p>
                </div>
              )}
            </section>
          </section>
        ) : null}
      </section>
    </main>
  );
}

export default TeacherPayrollPage;

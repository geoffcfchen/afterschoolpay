import { useEffect, useMemo, useState } from "react";
import { onAuthStateChanged, signOut } from "firebase/auth";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { auth } from "../lib/firebase";
import { subscribeBranchExpenses } from "../lib/expenseData";
import {
  isDisplayNameSetupRequiredError,
  isOrganizationSetupRequiredError,
  loadOrganizationWorkspace,
} from "../lib/orgData";
import {
  getPaymentMethodLabel,
  subscribeOrganizationStudents,
  subscribeStudentPayments,
} from "../lib/studentInvoiceData";
import {
  getPayrollTypeLabel,
  subscribeEmployeeSalarySlips,
  subscribeOrganizationEmployees,
} from "../lib/teacherPayrollData";

const ALL_BRANCHES = "all";

function getWorkspaceErrorMessage(error) {
  if (error.code === "permission-denied") {
    return "Firestore 拒絕讀取收支總覽。請確認 Firestore rules 與你的分校權限。";
  }

  return "帳號已登入，但目前無法載入收支總覽。";
}

function currentMonthValue() {
  const now = new Date();

  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function formatCurrency(amount) {
  const value = Number(amount) || 0;

  return `NT$${value.toLocaleString()}`;
}

function formatDate(value) {
  if (!value) {
    return "未記錄";
  }

  if (/^\d{4}-\d{2}(-\d{2})?$/.test(String(value))) {
    const [year, month, date] = String(value).split("-");

    return date ? `${year}/${Number(month)}/${Number(date)}` : `${year}/${Number(month)}`;
  }

  const date = typeof value?.toDate === "function" ? value.toDate() : new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "未記錄";
  }

  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
}

function formatDateTime(value) {
  if (!value) {
    return "未記錄";
  }

  const date = typeof value?.toDate === "function" ? value.toDate() : new Date(value);

  if (Number.isNaN(date.getTime())) {
    return formatDate(value);
  }

  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()} ${String(
    date.getHours(),
  ).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function getMonthKey(value) {
  if (!value) {
    return "";
  }

  if (/^\d{4}-\d{2}/.test(String(value))) {
    return String(value).slice(0, 7);
  }

  const date = typeof value?.toDate === "function" ? value.toDate() : new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function getPaymentBranchId(payment) {
  return (
    payment.receivedAtBranchId ||
    payment.receivedAtBranchSnapshot?.id ||
    payment.invoiceSourceBranchId ||
    payment.invoiceSourceBranchSnapshot?.id ||
    ""
  );
}

function getPaymentBranchName(payment) {
  return (
    payment.receivedAtBranchSnapshot?.name ||
    payment.invoiceSourceBranchSnapshot?.name ||
    "未記錄分校"
  );
}

function getSalaryDateValue(salarySlip) {
  return (
    salarySlip.paidAtIso ||
    salarySlip.paidAt ||
    salarySlip.salaryDate ||
    salarySlip.salaryMonth ||
    salarySlip.period?.month ||
    salarySlip.period?.startDate ||
    salarySlip.issuedAtIso ||
    ""
  );
}

function getSalaryAmount(salarySlip) {
  const paidTotal = Number(salarySlip?.paidTotal) || 0;

  return paidTotal > 0 ? paidTotal : Number(salarySlip?.total) || 0;
}

function getRecordSortValue(record) {
  return String(record.sortDate || record.date || "");
}

function sortDetails(records) {
  return [...records].sort((first, second) =>
    getRecordSortValue(second).localeCompare(getRecordSortValue(first)),
  );
}

function FinancialSummaryPage() {
  const navigate = useNavigate();
  const [authStatus, setAuthStatus] = useState(auth ? "checking" : "error");
  const [currentUser, setCurrentUser] = useState(null);
  const [workspace, setWorkspace] = useState(null);
  const [loadError, setLoadError] = useState(
    auth ? "" : "這個版本尚未設定 Firebase。",
  );
  const [selectedMonth, setSelectedMonth] = useState(currentMonthValue());
  const [activeBranchId, setActiveBranchId] = useState(ALL_BRANCHES);
  const [students, setStudents] = useState([]);
  const [studentLoadStatus, setStudentLoadStatus] = useState("idle");
  const [studentLoadError, setStudentLoadError] = useState("");
  const [payments, setPayments] = useState([]);
  const [paymentLoadStatus, setPaymentLoadStatus] = useState("idle");
  const [paymentLoadError, setPaymentLoadError] = useState("");
  const [employees, setEmployees] = useState([]);
  const [employeeLoadStatus, setEmployeeLoadStatus] = useState("idle");
  const [employeeLoadError, setEmployeeLoadError] = useState("");
  const [salarySlips, setSalarySlips] = useState([]);
  const [salarySlipLoadStatus, setSalarySlipLoadStatus] = useState("idle");
  const [salarySlipLoadError, setSalarySlipLoadError] = useState("");
  const [expenses, setExpenses] = useState([]);
  const [expenseLoadStatus, setExpenseLoadStatus] = useState("idle");
  const [expenseLoadError, setExpenseLoadError] = useState("");

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
        console.error("Unable to load financial summary workspace:", error);

        if (active) {
          if (isDisplayNameSetupRequiredError(error)) {
            navigate("/profile-setup?next=/financial-summary", { replace: true });
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

  const canRecordDailyLedger =
    workspace?.member?.roleLevel === 1 ||
    workspace?.member?.permissions?.canRecordDailyLedger;
  const canViewPayroll =
    workspace?.member?.roleLevel === 1 ||
    workspace?.member?.permissions?.canViewPayroll;
  const canUseFinancialSummary = canRecordDailyLedger && canViewPayroll;
  const branchOptions = useMemo(
    () => workspace?.visibleBranches || [],
    [workspace?.visibleBranches],
  );
  const canViewAllBranches =
    workspace?.member?.roleLevel === 1 ||
    workspace?.member?.permissions?.canViewAllBranches;
  const branchIds = useMemo(
    () => branchOptions.map((branch) => branch.id).filter(Boolean),
    [branchOptions],
  );
  const branchIdsKey = branchIds.join("|");
  const selectedBranchIds = useMemo(
    () =>
      activeBranchId === ALL_BRANCHES
        ? branchIds
        : branchIds.includes(activeBranchId)
          ? [activeBranchId]
          : branchIds,
    [activeBranchId, branchIds],
  );
  const selectedBranchName =
    activeBranchId === ALL_BRANCHES
      ? "全部分校"
      : branchOptions.find((branch) => branch.id === activeBranchId)?.name ||
        "全部分校";

  useEffect(() => {
    if (
      authStatus !== "ready" ||
      !canUseFinancialSummary ||
      !workspace?.activeOrgId
    ) {
      return undefined;
    }

    let active = true;
    let unsubscribe = () => {};

    Promise.resolve().then(() => {
      if (!active) {
        return;
      }

      setStudentLoadStatus("loading");
      setStudentLoadError("");

      try {
        unsubscribe = subscribeOrganizationStudents({
          branchIds,
          canViewAllBranches,
          onChange: (records) => {
            if (!active) {
              return;
            }

            setStudents(records);
            setStudentLoadStatus("ready");
          },
          onError: (error) => {
            console.error("Unable to listen to summary students:", error);

            if (!active) {
              return;
            }

            setStudents([]);
            setStudentLoadStatus("error");
            setStudentLoadError("無法載入學生收款來源。");
          },
          orgId: workspace.activeOrgId,
        });
      } catch (error) {
        console.error("Unable to start summary student listener:", error);

        if (!active) {
          return;
        }

        setStudents([]);
        setStudentLoadStatus("error");
        setStudentLoadError("無法啟動學生收款同步。");
      }
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [
    authStatus,
    branchIds,
    canUseFinancialSummary,
    canViewAllBranches,
    workspace?.activeOrgId,
  ]);

  const studentIdsKey = useMemo(
    () => students.map((student) => student.id).join("|"),
    [students],
  );

  useEffect(() => {
    if (
      authStatus !== "ready" ||
      !canUseFinancialSummary ||
      !workspace?.activeOrgId
    ) {
      return undefined;
    }

    let active = true;
    let unsubscribers = [];

    Promise.resolve().then(() => {
      if (!active) {
        return;
      }

      const sourceStudents = students.filter((student) => student.id);

      if (!sourceStudents.length) {
        setPayments([]);
        setPaymentLoadStatus(studentLoadStatus === "ready" ? "ready" : "idle");
        setPaymentLoadError("");
        return;
      }

      const recordsByStudent = new Map();
      const pendingStudentIds = new Set(sourceStudents.map((student) => student.id));

      setPayments([]);
      setPaymentLoadStatus("loading");
      setPaymentLoadError("");

      unsubscribers = sourceStudents.map((student) =>
        subscribeStudentPayments({
          onChange: (records) => {
            if (!active) {
              return;
            }

            pendingStudentIds.delete(student.id);
            recordsByStudent.set(
              student.id,
              records.map((record) => ({
                ...record,
                sourceStudentId: student.id,
              })),
            );
            setPayments([...recordsByStudent.values()].flat());

            if (!pendingStudentIds.size) {
              setPaymentLoadStatus("ready");
            }
          },
          onError: (error) => {
            console.error("Unable to listen to summary payments:", error);

            if (!active) {
              return;
            }

            setPaymentLoadStatus("error");
            setPaymentLoadError("無法載入學生收款紀錄。");
          },
          orgId: workspace.activeOrgId,
          studentId: student.id,
        }),
      );
    });

    return () => {
      active = false;
      unsubscribers.forEach((unsubscribe) => unsubscribe());
    };
  }, [
    authStatus,
    canUseFinancialSummary,
    studentIdsKey,
    studentLoadStatus,
    students,
    workspace?.activeOrgId,
  ]);

  useEffect(() => {
    if (
      authStatus !== "ready" ||
      !canUseFinancialSummary ||
      !workspace?.activeOrgId
    ) {
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
          branchIds,
          canViewAllBranches,
          onChange: (records) => {
            if (!active) {
              return;
            }

            setEmployees(records);
            setEmployeeLoadStatus("ready");
          },
          onError: (error) => {
            console.error("Unable to listen to summary employees:", error);

            if (!active) {
              return;
            }

            setEmployees([]);
            setEmployeeLoadStatus("error");
            setEmployeeLoadError("無法載入老師薪資來源。");
          },
          orgId: workspace.activeOrgId,
        });
      } catch (error) {
        console.error("Unable to start summary employee listener:", error);

        if (!active) {
          return;
        }

        setEmployees([]);
        setEmployeeLoadStatus("error");
        setEmployeeLoadError("無法啟動老師薪資同步。");
      }
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [
    authStatus,
    branchIds,
    canUseFinancialSummary,
    canViewAllBranches,
    workspace?.activeOrgId,
  ]);

  const employeeIdsKey = useMemo(
    () => employees.map((employee) => employee.id).join("|"),
    [employees],
  );

  useEffect(() => {
    if (
      authStatus !== "ready" ||
      !canUseFinancialSummary ||
      !workspace?.activeOrgId
    ) {
      return undefined;
    }

    let active = true;
    let unsubscribers = [];

    Promise.resolve().then(() => {
      if (!active) {
        return;
      }

      const sourceEmployees = employees.filter((employee) => employee.id);

      if (!sourceEmployees.length) {
        setSalarySlips([]);
        setSalarySlipLoadStatus(employeeLoadStatus === "ready" ? "ready" : "idle");
        setSalarySlipLoadError("");
        return;
      }

      const recordsByEmployee = new Map();
      const pendingEmployeeIds = new Set(
        sourceEmployees.map((employee) => employee.id),
      );

      setSalarySlips([]);
      setSalarySlipLoadStatus("loading");
      setSalarySlipLoadError("");

      unsubscribers = sourceEmployees.map((employee) =>
        subscribeEmployeeSalarySlips({
          employeeId: employee.id,
          onChange: (records) => {
            if (!active) {
              return;
            }

            pendingEmployeeIds.delete(employee.id);
            recordsByEmployee.set(
              employee.id,
              records.map((record) => ({
                ...record,
                sourceEmployeeId: employee.id,
              })),
            );
            setSalarySlips([...recordsByEmployee.values()].flat());

            if (!pendingEmployeeIds.size) {
              setSalarySlipLoadStatus("ready");
            }
          },
          onError: (error) => {
            console.error("Unable to listen to summary salary slips:", error);

            if (!active) {
              return;
            }

            setSalarySlipLoadStatus("error");
            setSalarySlipLoadError("無法載入老師薪資單。");
          },
          orgId: workspace.activeOrgId,
        }),
      );
    });

    return () => {
      active = false;
      unsubscribers.forEach((unsubscribe) => unsubscribe());
    };
  }, [
    authStatus,
    canUseFinancialSummary,
    employeeIdsKey,
    employeeLoadStatus,
    employees,
    workspace?.activeOrgId,
  ]);

  useEffect(() => {
    if (
      authStatus !== "ready" ||
      !canUseFinancialSummary ||
      !workspace?.activeOrgId
    ) {
      return undefined;
    }

    let active = true;
    let unsubscribers = [];

    Promise.resolve().then(() => {
      if (!active) {
        return;
      }

      if (!branchIds.length) {
        setExpenses([]);
        setExpenseLoadStatus("ready");
        setExpenseLoadError("");
        return;
      }

      const recordsByBranch = new Map();
      const pendingBranchIds = new Set(branchIds);

      setExpenses([]);
      setExpenseLoadStatus("loading");
      setExpenseLoadError("");

      unsubscribers = branchIds.map((branchId) =>
        subscribeBranchExpenses({
          branchId,
          onChange: (records) => {
            if (!active) {
              return;
            }

            pendingBranchIds.delete(branchId);
            recordsByBranch.set(
              branchId,
              records.map((record) => ({
                ...record,
                sourceBranchId: branchId,
              })),
            );
            setExpenses([...recordsByBranch.values()].flat());

            if (!pendingBranchIds.size) {
              setExpenseLoadStatus("ready");
            }
          },
          onError: (error) => {
            console.error("Unable to listen to summary expenses:", error);

            if (!active) {
              return;
            }

            setExpenseLoadStatus("error");
            setExpenseLoadError("無法載入雜項支出。");
          },
          orgId: workspace.activeOrgId,
        }),
      );
    });

    return () => {
      active = false;
      unsubscribers.forEach((unsubscribe) => unsubscribe());
    };
  }, [
    authStatus,
    branchIds,
    branchIdsKey,
    canUseFinancialSummary,
    workspace?.activeOrgId,
  ]);

  const filteredPayments = useMemo(
    () =>
      payments.filter(
        (payment) =>
          payment.status !== "void" &&
          payment.status !== "cancelled" &&
          getMonthKey(payment.receivedAtIso || payment.receivedAt) ===
            selectedMonth &&
          selectedBranchIds.includes(getPaymentBranchId(payment)),
      ),
    [payments, selectedBranchIds, selectedMonth],
  );
  const paidSalarySlips = useMemo(
    () =>
      salarySlips.filter(
        (salarySlip) =>
          salarySlip.status === "paid" &&
          getMonthKey(getSalaryDateValue(salarySlip)) === selectedMonth &&
          selectedBranchIds.includes(salarySlip.branchId),
      ),
    [salarySlips, selectedBranchIds, selectedMonth],
  );
  const filteredExpenses = useMemo(
    () =>
      expenses.filter(
        (expense) =>
          expense.status !== "void" &&
          getMonthKey(expense.expenseDate || expense.createdAtIso) ===
            selectedMonth &&
          selectedBranchIds.includes(expense.branchId || expense.sourceBranchId),
      ),
    [expenses, selectedBranchIds, selectedMonth],
  );

  const incomeTotal = useMemo(
    () =>
      filteredPayments.reduce(
        (total, payment) => total + (Number(payment.amount) || 0),
        0,
      ),
    [filteredPayments],
  );
  const salaryExpenseTotal = useMemo(
    () =>
      paidSalarySlips.reduce(
        (total, salarySlip) => total + getSalaryAmount(salarySlip),
        0,
      ),
    [paidSalarySlips],
  );
  const miscExpenseTotal = useMemo(
    () =>
      filteredExpenses.reduce(
        (total, expense) => total + (Number(expense.amount) || 0),
        0,
      ),
    [filteredExpenses],
  );
  const expenseTotal = salaryExpenseTotal + miscExpenseTotal;
  const profitTotal = incomeTotal - expenseTotal;

  const incomeDetails = useMemo(
    () =>
      sortDetails(
        filteredPayments.map((payment) => ({
          amount: Number(payment.amount) || 0,
          branchName: getPaymentBranchName(payment),
          date: payment.receivedAtIso || payment.receivedAt,
          id: `payment-${payment.sourceStudentId || payment.studentId}-${payment.id}`,
          meta: `${payment.studentSnapshot?.name || "未記錄學生"} · ${getPaymentMethodLabel(
            payment.method,
          )}`,
          number: payment.receiptNumber || payment.id,
          sortDate: payment.receivedAtIso || "",
          title: "學生收款",
        })),
      ),
    [filteredPayments],
  );
  const salaryDetails = useMemo(
    () =>
      sortDetails(
        paidSalarySlips.map((salarySlip) => ({
          amount: getSalaryAmount(salarySlip),
          branchName: salarySlip.branchSnapshot?.name || "未記錄分校",
          date: getSalaryDateValue(salarySlip),
          id: `salary-${salarySlip.sourceEmployeeId || salarySlip.employeeId}-${
            salarySlip.id
          }`,
          meta: `${salarySlip.employeeSnapshot?.name || "未記錄老師"} · ${getPayrollTypeLabel(
            salarySlip.payrollType,
          )}`,
          number: salarySlip.salarySlipNumber || salarySlip.id,
          sortDate: getSalaryDateValue(salarySlip),
          title: "老師薪資",
        })),
      ),
    [paidSalarySlips],
  );
  const expenseDetails = useMemo(
    () =>
      sortDetails(
        filteredExpenses.map((expense) => ({
          amount: Number(expense.amount) || 0,
          branchName: expense.branchSnapshot?.name || "未記錄分校",
          date: expense.expenseDate || expense.createdAtIso,
          id: `expense-${expense.sourceBranchId || expense.branchId}-${expense.id}`,
          meta: `紀錄人：${expense.createdByName || "未記錄"}`,
          number: expense.id,
          sortDate: expense.expenseDate || expense.createdAtIso || "",
          title: expense.itemName || "雜項支出",
        })),
      ),
    [filteredExpenses],
  );
  const allDetails = useMemo(
    () =>
      sortDetails([
        ...incomeDetails.map((record) => ({ ...record, direction: "income" })),
        ...salaryDetails.map((record) => ({ ...record, direction: "expense" })),
        ...expenseDetails.map((record) => ({ ...record, direction: "expense" })),
      ]),
    [expenseDetails, incomeDetails, salaryDetails],
  );
  const isLoading = [
    studentLoadStatus,
    paymentLoadStatus,
    employeeLoadStatus,
    salarySlipLoadStatus,
    expenseLoadStatus,
  ].includes("loading");
  const loadErrors = [
    studentLoadError,
    paymentLoadError,
    employeeLoadError,
    salarySlipLoadError,
    expenseLoadError,
  ].filter(Boolean);

  const handleSignOut = async () => {
    if (!auth) {
      return;
    }

    await signOut(auth);
    navigate("/");
  };

  const renderDetailList = (records, emptyText) => (
    <div className="financial-detail-list">
      {records.length ? (
        records.map((record) => (
          <article className="financial-detail-card" key={record.id}>
            <div>
              <strong>{record.title}</strong>
              <p>
                {record.number} · {record.meta}
              </p>
              <small>
                {formatDateTime(record.date)} · {record.branchName}
              </small>
            </div>
            <span
              className={
                record.direction === "income"
                  ? "financial-amount income"
                  : "financial-amount expense"
              }
            >
              {record.direction === "income" ? "+" : "-"}
              {formatCurrency(record.amount)}
            </span>
          </article>
        ))
      ) : (
        <p className="ledger-state-note">{emptyText}</p>
      )}
    </div>
  );

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
          <p>正在載入收支總覽...</p>
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
            <span>收支總覽</span>
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
          <h1>無法載入收支總覽</h1>
          <p>{loadError}</p>
        </section>
      </main>
    );
  }

  if (!canUseFinancialSummary) {
    return (
      <main className="dashboard-page">
        <header className="dashboard-topbar">
          <Link className="dashboard-brand" to="/dashboard">
            <span className="brand-mark dark" aria-hidden="true">
              AP
            </span>
            <span>收支總覽</span>
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
          <h1>尚不能使用收支總覽</h1>
          <p>請負責人同時開通每日收支與老師薪資權限後，再查看每月盈餘。</p>
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
          <span>收支總覽</span>
        </Link>
        <div className="dashboard-user-row">
          <Link className="dashboard-text-link" to="/daily-ledger">
            每日收支
          </Link>
          <Link className="dashboard-text-link" to="/students-courses">
            學生與課程
          </Link>
          <Link className="dashboard-text-link" to="/teacher-payroll">
            老師薪資
          </Link>
          <span className="dashboard-email">
            {workspace.profile?.displayName ||
              currentUser?.displayName ||
              currentUser?.email}
          </span>
          <button
            className="dashboard-sign-out"
            onClick={handleSignOut}
            type="button"
          >
            登出
          </button>
        </div>
      </header>

      <section className="financial-shell" aria-labelledby="financial-title">
        <div className="import-hero ledger-hero">
          <div>
            <p className="dashboard-kicker">月報</p>
            <h1 id="financial-title">收支總覽</h1>
            <p>
              依月份與分校彙總學生收款、老師薪資發放與雜項支出，計算當月盈餘。
            </p>
          </div>
          <span>{workspace.organization.name}</span>
        </div>

        <section
          className="branch-workspace-panel financial-filter-panel"
          aria-label="收支總覽篩選"
        >
          <div>
            <p className="dashboard-kicker">查詢條件</p>
            <h2>
              {selectedMonth} · {selectedBranchName}
            </h2>
            <p>盈餘 = 學生收款 - 老師薪資發放 - 雜項支出。</p>
          </div>
          <div className="financial-filter-controls">
            <label>
              月份
              <input
                onChange={(event) => setSelectedMonth(event.target.value)}
                type="month"
                value={selectedMonth}
              />
            </label>
            <label>
              分校
              <select
                onChange={(event) => setActiveBranchId(event.target.value)}
                value={activeBranchId}
              >
                <option value={ALL_BRANCHES}>全部分校</option>
                {branchOptions.map((branch) => (
                  <option key={branch.id} value={branch.id}>
                    {branch.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </section>

        {isLoading ? (
          <p className="ledger-state-note">正在同步收支資料...</p>
        ) : null}

        {loadErrors.length ? (
          <div className="financial-error-list">
            {loadErrors.map((error) => (
              <p className="ledger-state-note error" key={error}>
                {error}
              </p>
            ))}
          </div>
        ) : null}

        <section className="financial-summary-grid" aria-label="月收支摘要">
          <article className="financial-summary-card income">
            <span>收入</span>
            <strong>{formatCurrency(incomeTotal)}</strong>
            <p>{filteredPayments.length} 筆學生收款</p>
          </article>
          <article className="financial-summary-card expense">
            <span>老師薪資</span>
            <strong>{formatCurrency(salaryExpenseTotal)}</strong>
            <p>{paidSalarySlips.length} 張已發放薪資單</p>
          </article>
          <article className="financial-summary-card expense">
            <span>雜項支出</span>
            <strong>{formatCurrency(miscExpenseTotal)}</strong>
            <p>{filteredExpenses.length} 筆支出紀錄</p>
          </article>
          <article
            className={`financial-summary-card ${
              profitTotal >= 0 ? "profit" : "loss"
            }`}
          >
            <span>盈餘</span>
            <strong>{formatCurrency(profitTotal)}</strong>
            <p>收入 - 支出 = {formatCurrency(incomeTotal)} - {formatCurrency(expenseTotal)}</p>
          </article>
        </section>

        <section className="financial-detail-grid" aria-label="收支明細">
          <section className="ledger-profile-panel">
            <div className="ledger-profile-heading">
              <div>
                <p className="dashboard-kicker">收入明細</p>
                <h2>學生收款</h2>
              </div>
              <em className="ledger-student-id-badge">
                {formatCurrency(incomeTotal)}
              </em>
            </div>
            {renderDetailList(incomeDetails, "此月份沒有學生收款。")}
          </section>

          <section className="ledger-profile-panel">
            <div className="ledger-profile-heading">
              <div>
                <p className="dashboard-kicker">支出明細</p>
                <h2>老師薪資</h2>
              </div>
              <em className="ledger-student-id-badge">
                {formatCurrency(salaryExpenseTotal)}
              </em>
            </div>
            {renderDetailList(salaryDetails, "此月份沒有已發放老師薪資。")}
          </section>

          <section className="ledger-profile-panel">
            <div className="ledger-profile-heading">
              <div>
                <p className="dashboard-kicker">支出明細</p>
                <h2>雜項支出</h2>
              </div>
              <em className="ledger-student-id-badge">
                {formatCurrency(miscExpenseTotal)}
              </em>
            </div>
            {renderDetailList(expenseDetails, "此月份沒有雜項支出。")}
          </section>
        </section>

        <section className="ledger-profile-panel financial-all-detail-panel">
          <div className="ledger-profile-heading">
            <div>
              <p className="dashboard-kicker">全部明細</p>
              <h2>收入與支出時間序</h2>
            </div>
            <em className="ledger-student-id-badge">{allDetails.length} 筆</em>
          </div>
          {renderDetailList(allDetails, "此月份沒有收支明細。")}
        </section>
      </section>
    </main>
  );
}

export default FinancialSummaryPage;

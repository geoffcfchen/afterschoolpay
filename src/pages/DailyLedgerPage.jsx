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
  INVOICE_STATUS_LABELS,
  PAYMENT_METHOD_LABELS,
  createStudentInvoicePayment,
  getInvoiceStatusLabel,
  getPaymentMethodLabel,
  subscribeOrganizationStudents,
  subscribeStudentInvoices,
  subscribeStudentPayments,
  updateStudentInvoiceStatus,
} from "../lib/studentInvoiceData";
import {
  SALARY_SLIP_STATUS_LABELS,
  getPayrollTypeLabel,
  getSalarySlipStatusLabel,
  subscribeEmployeeSalarySlips,
  subscribeOrganizationEmployees,
  updateTeacherSalarySlipStatus,
} from "../lib/teacherPayrollData";

const ALL_CLASSES = "all";
const ALL_STATUSES = "all";

const INVOICE_STATUS_OPTIONS = [
  { value: "unpaid", label: INVOICE_STATUS_LABELS.unpaid },
  { value: "overdue", label: INVOICE_STATUS_LABELS.overdue },
  { value: "paid", label: INVOICE_STATUS_LABELS.paid },
  { value: "void", label: INVOICE_STATUS_LABELS.void },
];

const PAYMENT_METHOD_OPTIONS = Object.entries(PAYMENT_METHOD_LABELS).map(
  ([value, label]) => ({
    label,
    value,
  }),
);

const SALARY_STATUS_OPTIONS = [
  { value: "unpaid", label: SALARY_SLIP_STATUS_LABELS.unpaid },
  { value: "paid", label: SALARY_SLIP_STATUS_LABELS.paid },
  { value: "void", label: SALARY_SLIP_STATUS_LABELS.void },
];

function getWorkspaceErrorMessage(error) {
  if (error.code === "permission-denied") {
    return "Firestore 拒絕讀取每日收支。請確認 Firestore rules 與你的分校權限。";
  }

  return "帳號已登入，但目前無法載入每日收支工作台。";
}

function formatCurrency(amount) {
  const value = Number(amount) || 0;

  return `NT$${value.toLocaleString()}`;
}

function formatDateTime(value) {
  if (!value) {
    return "未記錄";
  }

  const date =
    typeof value?.toDate === "function" ? value.toDate() : new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "未記錄";
  }

  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()} ${String(
    date.getHours(),
  ).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function getShortStudentId(studentId = "") {
  return studentId.replace(/^student-/, "").slice(0, 8) || "未設定";
}

function getPrimaryLegacyNumber(student) {
  const numbers = Array.isArray(student?.legacyStudentNumbers)
    ? student.legacyStudentNumbers.filter(Boolean)
    : [];

  if (!numbers.length) {
    return "未設定";
  }

  return [...numbers].sort((first, second) =>
    String(first).localeCompare(String(second), undefined, {
      numeric: true,
      sensitivity: "base",
    }),
  )[0];
}

function getStudentBranchClasses(student) {
  const branchClasses = Array.isArray(student?.branchClasses)
    ? student.branchClasses
    : [];

  if (branchClasses.length) {
    return branchClasses
      .filter((record) => record?.branchId && record?.classId)
      .map((record) => ({
        branchId: record.branchId,
        branchName: record.branchName || "",
        branchShortName: record.branchShortName || "",
        classId: record.classId,
        className: record.className || record.classId,
      }));
  }

  const keys = Array.isArray(student?.branchClassKeys)
    ? student.branchClassKeys
    : [];
  const classNames = Array.isArray(student?.classNames) ? student.classNames : [];

  if (keys.length) {
    return keys
      .map((key, index) => {
        const [branchId, ...classParts] = String(key).split(":");
        const classId = classParts.join(":");

        return {
          branchId,
          branchName: "",
          branchShortName: "",
          classId,
          className: classNames.length === 1 ? classNames[0] : classId,
          sortIndex: index,
        };
      })
      .filter((record) => record.branchId && record.classId);
  }

  const branchIds = Array.isArray(student?.branchIds) ? student.branchIds : [];
  const classIds = Array.isArray(student?.classIds) ? student.classIds : [];

  return branchIds.flatMap((branchId) =>
    classIds.map((classId, index) => ({
      branchId,
      branchName: "",
      branchShortName: "",
      classId,
      className: classNames[index] || classId,
      sortIndex: index,
    })),
  );
}

function belongsToBranch(student, branchId) {
  if (!branchId) {
    return false;
  }

  const branchIds = Array.isArray(student?.branchIds) ? student.branchIds : [];

  return (
    branchIds.includes(branchId) ||
    getStudentBranchClasses(student).some((record) => record.branchId === branchId)
  );
}

function belongsToClass(student, branchId, classId) {
  if (!classId || classId === ALL_CLASSES) {
    return true;
  }

  return getStudentBranchClasses(student).some(
    (record) => record.branchId === branchId && record.classId === classId,
  );
}

function getStudentClassBadges(student, branchId) {
  const records = getStudentBranchClasses(student).filter(
    (record) => record.branchId === branchId,
  );
  const unique = new Map();

  records.forEach((record) => {
    unique.set(record.classId, record);
  });

  return [...unique.values()].sort((first, second) =>
    first.className.localeCompare(second.className, undefined, {
      numeric: true,
      sensitivity: "base",
    }),
  );
}

function sortStudentsByLegacyNumber(students) {
  return [...students].sort((first, second) => {
    const firstNumber = getPrimaryLegacyNumber(first);
    const secondNumber = getPrimaryLegacyNumber(second);

    if (firstNumber !== secondNumber) {
      return String(firstNumber).localeCompare(String(secondNumber), undefined, {
        numeric: true,
        sensitivity: "base",
      });
    }

    return (first.name || "").localeCompare(second.name || "", undefined, {
      numeric: true,
      sensitivity: "base",
    });
  });
}

function employeeBelongsToBranch(employee, branchId) {
  const branchIds = Array.isArray(employee?.branchIds) ? employee.branchIds : [];

  return branchIds.includes(branchId);
}

function getInvoiceAmount(invoice) {
  return Number(invoice?.balance ?? invoice?.total) || 0;
}

function getPaymentAmount(payment) {
  return Number(payment?.amount) || 0;
}

function getInvoiceStatus(invoice) {
  return invoice?.status || "unpaid";
}

function getCurrentUserDisplayName(workspace, user) {
  return workspace?.profile?.displayName || user?.displayName || user?.email || "";
}

function getSalarySlipAmount(salarySlip) {
  return Number(salarySlip?.balance ?? salarySlip?.total) || 0;
}

function getSalarySlipStatus(salarySlip) {
  return salarySlip?.status || "unpaid";
}

function getInvoiceLineDescription(line) {
  if (line.type === "course") {
    const dates = Array.isArray(line.dates) ? line.dates : [];

    return `${line.quantity || dates.length || 0} 堂${
      dates.length ? `：${dates.join("、")}` : ""
    }`;
  }

  return line.description || line.code || "無備註";
}

function getSalaryLineDescription(line) {
  if (line.type === "eightLessonsClass") {
    return line.description || `${line.quantity || 0} 小時`;
  }

  return line.description || "無備註";
}

function formatSalaryPeriod(salarySlip) {
  if (salarySlip?.period?.month) {
    return salarySlip.period.month;
  }

  const startDate = salarySlip?.period?.startDate || "";
  const endDate = salarySlip?.period?.endDate || "";

  if (startDate && endDate && startDate !== endDate) {
    return `${startDate} - ${endDate}`;
  }

  return startDate || endDate || salarySlip?.salaryDate || "未設定";
}

function DailyLedgerPage() {
  const navigate = useNavigate();
  const [authStatus, setAuthStatus] = useState(auth ? "checking" : "error");
  const [currentUser, setCurrentUser] = useState(null);
  const [workspace, setWorkspace] = useState(null);
  const [loadError, setLoadError] = useState(
    auth ? "" : "這個版本尚未設定 Firebase。",
  );
  const [ledgerMode, setLedgerMode] = useState("income");
  const [activeBranchId, setActiveBranchId] = useState("");
  const [activeClassId, setActiveClassId] = useState(ALL_CLASSES);
  const [students, setStudents] = useState([]);
  const [studentLoadStatus, setStudentLoadStatus] = useState("idle");
  const [studentLoadError, setStudentLoadError] = useState("");
  const [selectedStudentId, setSelectedStudentId] = useState("");
  const [invoiceRecords, setInvoiceRecords] = useState([]);
  const [invoiceLoadStatus, setInvoiceLoadStatus] = useState("idle");
  const [invoiceLoadError, setInvoiceLoadError] = useState("");
  const [statusFilter, setStatusFilter] = useState(ALL_STATUSES);
  const [updatingInvoiceId, setUpdatingInvoiceId] = useState("");
  const [statusMessage, setStatusMessage] = useState("");
  const [printInvoice, setPrintInvoice] = useState(null);
  const [paymentRecords, setPaymentRecords] = useState([]);
  const [paymentLoadStatus, setPaymentLoadStatus] = useState("idle");
  const [paymentLoadError, setPaymentLoadError] = useState("");
  const [paymentTargetInvoice, setPaymentTargetInvoice] = useState(null);
  const [paymentForm, setPaymentForm] = useState({
    amount: "",
    method: "cash",
    note: "",
  });
  const [paymentSaveStatus, setPaymentSaveStatus] = useState("idle");
  const [paymentError, setPaymentError] = useState("");
  const [printPayment, setPrintPayment] = useState(null);
  const [employees, setEmployees] = useState([]);
  const [employeeLoadStatus, setEmployeeLoadStatus] = useState("idle");
  const [employeeLoadError, setEmployeeLoadError] = useState("");
  const [selectedEmployeeId, setSelectedEmployeeId] = useState("");
  const [salarySlipRecords, setSalarySlipRecords] = useState([]);
  const [salarySlipLoadStatus, setSalarySlipLoadStatus] = useState("idle");
  const [salarySlipLoadError, setSalarySlipLoadError] = useState("");
  const [salaryStatusFilter, setSalaryStatusFilter] = useState(ALL_STATUSES);
  const [updatingSalarySlipId, setUpdatingSalarySlipId] = useState("");
  const [salaryStatusMessage, setSalaryStatusMessage] = useState("");
  const [printSalarySlip, setPrintSalarySlip] = useState(null);

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
        console.error("Unable to load daily ledger workspace:", error);

        if (active) {
          if (isDisplayNameSetupRequiredError(error)) {
            navigate("/profile-setup?next=/daily-ledger", { replace: true });
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
  const canUseDailyLedger = canRecordDailyLedger || canViewPayroll;
  const activeLedgerMode =
    ledgerMode === "payroll" && canViewPayroll
      ? "payroll"
      : ledgerMode === "income" && canRecordDailyLedger
        ? "income"
        : canRecordDailyLedger
          ? "income"
          : "payroll";
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
    if (
      authStatus !== "ready" ||
      !canRecordDailyLedger ||
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
          branchIds: allowedBranchKey
            ? allowedBranchKey.split("|").filter(Boolean)
            : [],
          canViewAllBranches,
          onChange: (records) => {
            if (!active) {
              return;
            }

            setStudents(records);
            setStudentLoadStatus("ready");
          },
          onError: (error) => {
            console.error("Unable to listen to organization students:", error);

            if (!active) {
              return;
            }

            setStudents([]);
            setStudentLoadStatus("error");
            setStudentLoadError("無法載入學生帳戶。請確認 Firestore 權限。");
          },
          orgId: workspace.activeOrgId,
        });
      } catch (error) {
        console.error("Unable to start organization student listener:", error);

        if (!active) {
          return;
        }

        setStudents([]);
        setStudentLoadStatus("error");
        setStudentLoadError("無法啟動學生帳戶同步。請確認 Firebase 設定。");
      }
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [
    allowedBranchKey,
    authStatus,
    canRecordDailyLedger,
    canViewAllBranches,
    workspace?.activeOrgId,
  ]);

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
            console.error("Unable to listen to organization employees:", error);

            if (!active) {
              return;
            }

            setEmployees([]);
            setEmployeeLoadStatus("error");
            setEmployeeLoadError("無法載入老師帳戶。請確認 Firestore 權限。");
          },
          orgId: workspace.activeOrgId,
        });
      } catch (error) {
        console.error("Unable to start organization employee listener:", error);

        if (!active) {
          return;
        }

        setEmployees([]);
        setEmployeeLoadStatus("error");
        setEmployeeLoadError("無法啟動老師帳戶同步。請確認 Firebase 設定。");
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

  const branchStudents = useMemo(
    () =>
      sortStudentsByLegacyNumber(
        students.filter((student) => belongsToBranch(student, activeBranchId)),
      ),
    [activeBranchId, students],
  );

  const classOptions = useMemo(() => {
    const classes = new Map();

    branchStudents.forEach((student) => {
      getStudentClassBadges(student, activeBranchId).forEach((record) => {
        classes.set(record.classId, record);
      });
    });

    return [...classes.values()].sort((first, second) =>
      first.className.localeCompare(second.className, undefined, {
        numeric: true,
        sensitivity: "base",
      }),
    );
  }, [activeBranchId, branchStudents]);

  const visibleStudents = useMemo(
    () =>
      branchStudents.filter((student) =>
        belongsToClass(student, activeBranchId, activeClassId),
      ),
    [activeBranchId, activeClassId, branchStudents],
  );

  const selectedStudent = useMemo(
    () =>
      visibleStudents.find((student) => student.id === selectedStudentId) ||
      visibleStudents[0] ||
      null,
    [selectedStudentId, visibleStudents],
  );

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

  useEffect(() => {
    let active = true;
    let unsubscribe = () => {};

    Promise.resolve().then(() => {
      if (!active) {
        return;
      }

      if (!workspace?.activeOrgId || !selectedStudent?.id) {
        setInvoiceRecords([]);
        setInvoiceLoadStatus("idle");
        setInvoiceLoadError("");
        return;
      }

      setInvoiceRecords([]);
      setInvoiceLoadStatus("loading");
      setInvoiceLoadError("");

      unsubscribe = subscribeStudentInvoices({
        onChange: (records) => {
          if (!active) {
            return;
          }

          setInvoiceRecords(records);
          setInvoiceLoadStatus("ready");
        },
        onError: (error) => {
          console.error("Unable to listen to student invoices:", error);

          if (!active) {
            return;
          }

          setInvoiceRecords([]);
          setInvoiceLoadStatus("error");
          setInvoiceLoadError("無法載入此學生的繳費通知單。");
        },
        orgId: workspace.activeOrgId,
        studentId: selectedStudent.id,
      });
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [selectedStudent?.id, workspace?.activeOrgId]);

  useEffect(() => {
    let active = true;
    let unsubscribe = () => {};

    Promise.resolve().then(() => {
      if (!active) {
        return;
      }

      if (!workspace?.activeOrgId || !selectedStudent?.id) {
        setPaymentRecords([]);
        setPaymentLoadStatus("idle");
        setPaymentLoadError("");
        return;
      }

      setPaymentRecords([]);
      setPaymentLoadStatus("loading");
      setPaymentLoadError("");

      unsubscribe = subscribeStudentPayments({
        onChange: (records) => {
          if (!active) {
            return;
          }

          setPaymentRecords(records);
          setPaymentLoadStatus("ready");
        },
        onError: (error) => {
          console.error("Unable to listen to student payments:", error);

          if (!active) {
            return;
          }

          setPaymentRecords([]);
          setPaymentLoadStatus("error");
          setPaymentLoadError("無法載入此學生的收款紀錄。");
        },
        orgId: workspace.activeOrgId,
        studentId: selectedStudent.id,
      });
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [selectedStudent?.id, workspace?.activeOrgId]);

  useEffect(() => {
    let active = true;
    let unsubscribe = () => {};

    Promise.resolve().then(() => {
      if (!active) {
        return;
      }

      if (!workspace?.activeOrgId || !selectedEmployee?.id) {
        setSalarySlipRecords([]);
        setSalarySlipLoadStatus("idle");
        setSalarySlipLoadError("");
        return;
      }

      setSalarySlipRecords([]);
      setSalarySlipLoadStatus("loading");
      setSalarySlipLoadError("");

      unsubscribe = subscribeEmployeeSalarySlips({
        employeeId: selectedEmployee.id,
        onChange: (records) => {
          if (!active) {
            return;
          }

          setSalarySlipRecords(records);
          setSalarySlipLoadStatus("ready");
        },
        onError: (error) => {
          console.error("Unable to listen to employee salary slips:", error);

          if (!active) {
            return;
          }

          setSalarySlipRecords([]);
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

  useEffect(() => {
    if (!printInvoice && !printSalarySlip && !printPayment && !paymentTargetInvoice) {
      return undefined;
    }

    const originalOverflow = document.body.style.overflow;
    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        setPrintInvoice(null);
        setPrintSalarySlip(null);
        setPrintPayment(null);
        setPaymentTargetInvoice(null);
      }
    };

    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      document.body.style.overflow = originalOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [paymentTargetInvoice, printInvoice, printPayment, printSalarySlip]);

  const invoiceCounts = useMemo(
    () =>
      INVOICE_STATUS_OPTIONS.reduce(
        (counts, option) => ({
          ...counts,
          [option.value]: invoiceRecords.filter(
            (invoice) => getInvoiceStatus(invoice) === option.value,
          ).length,
        }),
        { all: invoiceRecords.length },
      ),
    [invoiceRecords],
  );

  const filteredInvoices = useMemo(
    () =>
      invoiceRecords.filter(
        (invoice) =>
          statusFilter === ALL_STATUSES ||
          getInvoiceStatus(invoice) === statusFilter,
      ),
    [invoiceRecords, statusFilter],
  );

  const selectedStudentBalance = useMemo(
    () =>
      invoiceRecords
        .filter((invoice) => ["unpaid", "overdue"].includes(getInvoiceStatus(invoice)))
        .reduce((total, invoice) => total + getInvoiceAmount(invoice), 0),
    [invoiceRecords],
  );
  const selectedStudentPaidTotal = useMemo(
    () =>
      paymentRecords.reduce(
        (total, payment) => total + getPaymentAmount(payment),
        0,
      ),
    [paymentRecords],
  );

  const branchSalarySlips = useMemo(
    () =>
      salarySlipRecords.filter(
        (salarySlip) => salarySlip.branchId === activeBranchId,
      ),
    [activeBranchId, salarySlipRecords],
  );

  const salarySlipCounts = useMemo(
    () =>
      SALARY_STATUS_OPTIONS.reduce(
        (counts, option) => ({
          ...counts,
          [option.value]: branchSalarySlips.filter(
            (salarySlip) => getSalarySlipStatus(salarySlip) === option.value,
          ).length,
        }),
        { all: branchSalarySlips.length },
      ),
    [branchSalarySlips],
  );

  const filteredSalarySlips = useMemo(
    () =>
      branchSalarySlips.filter(
        (salarySlip) =>
          salaryStatusFilter === ALL_STATUSES ||
          getSalarySlipStatus(salarySlip) === salaryStatusFilter,
      ),
    [branchSalarySlips, salaryStatusFilter],
  );

  const selectedEmployeeUnpaidTotal = useMemo(
    () =>
      branchSalarySlips
        .filter((salarySlip) => getSalarySlipStatus(salarySlip) === "unpaid")
        .reduce((total, salarySlip) => total + getSalarySlipAmount(salarySlip), 0),
    [branchSalarySlips],
  );

  const handleSignOut = async () => {
    if (!auth) {
      return;
    }

    await signOut(auth);
    navigate("/");
  };

  const closePaymentModal = () => {
    setPaymentTargetInvoice(null);
    setPaymentForm({
      amount: "",
      method: "cash",
      note: "",
    });
    setPaymentError("");
    setPaymentSaveStatus("idle");
  };

  const openPaymentModal = (invoice) => {
    if (!invoice || getInvoiceStatus(invoice) === "void") {
      return;
    }

    setPaymentTargetInvoice(invoice);
    setPaymentForm({
      amount: String(getInvoiceAmount(invoice) || ""),
      method: "cash",
      note: "",
    });
    setPaymentError("");
    setPaymentSaveStatus("idle");
  };

  const handlePaymentSubmit = async (event) => {
    event.preventDefault();

    if (
      !paymentTargetInvoice?.id ||
      !selectedStudent?.id ||
      !selectedBranch?.id ||
      !workspace?.activeOrgId ||
      paymentSaveStatus === "saving"
    ) {
      return;
    }

    const amount = Math.round(Number(paymentForm.amount) || 0);
    const balance = getInvoiceAmount(paymentTargetInvoice);

    if (amount <= 0) {
      setPaymentError("收款金額必須大於 0。");
      return;
    }

    if (amount > balance) {
      setPaymentError("收款金額不能大於未收金額。");
      return;
    }

    setPaymentSaveStatus("saving");
    setPaymentError("");

    try {
      const saved = await createStudentInvoicePayment({
        amount,
        invoice: paymentTargetInvoice,
        method: paymentForm.method,
        note: paymentForm.note,
        organization: workspace.organization,
        orgId: workspace.activeOrgId,
        receivedAtBranch: selectedBranch,
        receivedBy: {
          displayName: getCurrentUserDisplayName(workspace, currentUser),
          email: currentUser?.email || "",
          uid: currentUser?.uid || "",
        },
        student: {
          ...selectedStudent,
          primaryLegacyNumber: getPrimaryLegacyNumber(selectedStudent),
        },
      });

      setStatusMessage(`已建立收據 ${saved.receiptNumber}。`);
      setPrintPayment(saved.payment);
      closePaymentModal();
    } catch (error) {
      console.error("Unable to create student payment:", error);
      setPaymentError(error.message || "收款失敗。請確認 Firestore 權限後再試一次。");
      setPaymentSaveStatus("idle");
    }
  };

  const handleStatusChange = async (invoice, status) => {
    if (
      !selectedStudent?.id ||
      !invoice?.id ||
      !workspace?.activeOrgId ||
      updatingInvoiceId
    ) {
      return;
    }

    if (status === "paid") {
      openPaymentModal(invoice);
      return;
    }

    setUpdatingInvoiceId(invoice.id);
    setStatusMessage("");

    try {
      await updateStudentInvoiceStatus({
        invoiceId: invoice.id,
        orgId: workspace.activeOrgId,
        status,
        studentId: selectedStudent.id,
        total: invoice.total,
        updatedByUid: currentUser?.uid || "",
      });
      setStatusMessage(`已更新 ${invoice.invoiceNumber || "繳費通知單"} 狀態。`);
    } catch (error) {
      console.error("Unable to update invoice status:", error);
      setStatusMessage("狀態更新失敗。請確認 Firestore 權限後再試一次。");
    } finally {
      setUpdatingInvoiceId("");
    }
  };

  const handleSalaryStatusChange = async (salarySlip, status) => {
    if (
      !selectedEmployee?.id ||
      !salarySlip?.id ||
      !workspace?.activeOrgId ||
      updatingSalarySlipId
    ) {
      return;
    }

    setUpdatingSalarySlipId(salarySlip.id);
    setSalaryStatusMessage("");

    try {
      await updateTeacherSalarySlipStatus({
        employeeId: selectedEmployee.id,
        orgId: workspace.activeOrgId,
        salarySlipId: salarySlip.id,
        status,
        total: salarySlip.total,
        updatedByUid: currentUser?.uid || "",
      });
      setSalaryStatusMessage(
        `已更新 ${salarySlip.salarySlipNumber || "老師薪資單"} 狀態。`,
      );
    } catch (error) {
      console.error("Unable to update teacher salary slip status:", error);
      setSalaryStatusMessage("狀態更新失敗。請確認 Firestore 權限後再試一次。");
    } finally {
      setUpdatingSalarySlipId("");
    }
  };

  const renderInvoicePrint = (invoice) => {
    const studentName =
      invoice.studentSnapshot?.name || selectedStudent?.name || "未記錄";
    const studentNumber =
      invoice.studentSnapshot?.studentNumber ||
      getPrimaryLegacyNumber(selectedStudent) ||
      "未記錄";

    return (
      <div className="invoice-print-area">
        <header>
          <p>{workspace.organization.name}</p>
          <h2>繳費通知單</h2>
        </header>
        <div className="invoice-meta-grid">
          <span>通知單：{invoice.invoiceNumber || invoice.id}</span>
          <span>分校：{invoice.sourceBranchSnapshot?.name || "未記錄"}</span>
          <span>班級：{invoice.className || "未記錄"}</span>
          <span>編號：{studentNumber}</span>
          <span>學生：{studentName}</span>
          <span>狀態：{getInvoiceStatusLabel(invoice.status)}</span>
        </div>
        <table>
          <thead>
            <tr>
              <th>項目</th>
              <th>堂數 / 說明</th>
              <th>金額</th>
            </tr>
          </thead>
          <tbody>
            {(invoice.lineItems || []).map((line) => (
              <tr key={line.id}>
                <td>{line.name || "未命名項目"}</td>
                <td>{getInvoiceLineDescription(line)}</td>
                <td>{formatCurrency(line.amount)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan="2">本期應繳合計</td>
              <td>{formatCurrency(invoice.total)}</td>
            </tr>
            <tr>
              <td colSpan="2">目前未收</td>
              <td>{formatCurrency(invoice.balance ?? invoice.total)}</td>
            </tr>
          </tfoot>
        </table>
        <p className="invoice-receipt-note">
          列印日期：{formatDateTime(new Date().toISOString())}。收款完成後請在每日收支更新狀態。
        </p>
      </div>
    );
  };

  const renderPaymentReceipt = (payment) => {
    const studentName =
      payment.studentSnapshot?.name || selectedStudent?.name || "未記錄";
    const studentNumber =
      payment.studentSnapshot?.studentNumber ||
      getPrimaryLegacyNumber(selectedStudent) ||
      "未記錄";

    return (
      <div className="invoice-print-area receipt-print-area">
        <header>
          <p>{payment.organizationSnapshot?.name || workspace.organization.name}</p>
          <h2>收據</h2>
        </header>
        <div className="invoice-meta-grid">
          <span>收據：{payment.receiptNumber || payment.id}</span>
          <span>收款日期：{formatDateTime(payment.receivedAtIso)}</span>
          <span>
            收款分校：{payment.receivedAtBranchSnapshot?.name || "未記錄"}
          </span>
          <span>收款人：{payment.receivedByName || "未記錄"}</span>
          <span>學生：{studentName}</span>
          <span>編號：{studentNumber}</span>
          <span>通知單：{payment.invoiceNumber || payment.invoiceId}</span>
          <span>
            通知單分校：{payment.invoiceSourceBranchSnapshot?.name || "未記錄"}
          </span>
          <span>付款方式：{getPaymentMethodLabel(payment.method)}</span>
        </div>
        <table>
          <thead>
            <tr>
              <th>項目</th>
              <th>說明</th>
              <th>金額</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>繳費通知單收款</td>
              <td>{payment.invoiceNumber || payment.invoiceId}</td>
              <td>{formatCurrency(payment.amount)}</td>
            </tr>
          </tbody>
          <tfoot>
            <tr>
              <td colSpan="2">本次收款</td>
              <td>{formatCurrency(payment.amount)}</td>
            </tr>
            <tr>
              <td colSpan="2">收款後未收</td>
              <td>{formatCurrency(payment.balanceAfter)}</td>
            </tr>
          </tfoot>
        </table>
        {payment.note ? (
          <p className="invoice-receipt-note">備註：{payment.note}</p>
        ) : null}
        <p className="invoice-receipt-note">
          列印日期：{formatDateTime(new Date().toISOString())}。此收據依每日收支收款紀錄產生。
        </p>
      </div>
    );
  };

  const renderSalarySlipPrint = (salarySlip) => {
    const employeeName =
      salarySlip.employeeSnapshot?.name || selectedEmployee?.name || "未記錄";

    return (
      <div className="invoice-print-area salary-print-area">
        <header>
          <p>{workspace.organization.name}</p>
          <h2>老師薪資單</h2>
        </header>
        <div className="invoice-meta-grid">
          <span>薪資單：{salarySlip.salarySlipNumber || salarySlip.id}</span>
          <span>分校：{salarySlip.branchSnapshot?.name || "未記錄"}</span>
          <span>老師：{employeeName}</span>
          <span>計薪：{getPayrollTypeLabel(salarySlip.payrollType)}</span>
          <span>期間：{formatSalaryPeriod(salarySlip)}</span>
          <span>狀態：{getSalarySlipStatusLabel(salarySlip.status)}</span>
        </div>
        <table>
          <thead>
            <tr>
              <th>項目</th>
              <th>堂數 / 說明</th>
              <th>金額</th>
            </tr>
          </thead>
          <tbody>
            {(salarySlip.lineItems || []).map((line) => (
              <tr key={line.id}>
                <td>{line.name || "未命名項目"}</td>
                <td>{getSalaryLineDescription(line)}</td>
                <td>{formatCurrency(line.amount)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan="2">本期應發合計</td>
              <td>{formatCurrency(salarySlip.total)}</td>
            </tr>
            <tr>
              <td colSpan="2">目前未發</td>
              <td>{formatCurrency(salarySlip.balance ?? salarySlip.total)}</td>
            </tr>
          </tfoot>
        </table>

        {(salarySlip.classes || []).length ? (
          <div className="salary-print-detail">
            {(salarySlip.classes || []).map((classRecord) => (
              <section key={classRecord.id}>
                <h3>{classRecord.className}</h3>
                <table>
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
                    {(classRecord.sessions || []).map((session) => (
                      <tr key={session.id}>
                        <td>{session.sequence}</td>
                        <td>{session.date || "未設定"}</td>
                        <td>{formatCurrency(session.hourlyRate)}</td>
                        <td>{session.hours}</td>
                        <td>{formatCurrency(session.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            ))}
          </div>
        ) : null}

        <p className="invoice-receipt-note">
          列印日期：{formatDateTime(new Date().toISOString())}。發放完成後請在每日收支更新狀態。
        </p>
      </div>
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
          <p>正在載入每日收支...</p>
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
            <span>每日收支</span>
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
          <h1>無法載入每日收支</h1>
          <p>{loadError}</p>
        </section>
      </main>
    );
  }

  if (!canUseDailyLedger) {
    return (
      <main className="dashboard-page">
        <header className="dashboard-topbar no-print">
          <Link className="dashboard-brand" to="/dashboard">
            <span className="brand-mark dark" aria-hidden="true">
              AP
            </span>
            <span>每日收支</span>
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
          <h1>尚不能使用每日收支</h1>
          <p>請負責人開通每日收支或老師薪資權限後，再處理帳務狀態。</p>
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
          <span>每日收支</span>
        </Link>
        <div className="dashboard-user-row">
          <Link className="dashboard-text-link" to="/students-courses">
            學生與課程
          </Link>
          {canViewPayroll ? (
            <Link className="dashboard-text-link" to="/teacher-payroll">
              老師薪資
            </Link>
          ) : null}
          <span className="dashboard-email">
            {workspace.profile?.displayName ||
              currentUser?.displayName ||
              currentUser?.email}
          </span>
          <Link
            className="dashboard-text-link"
            to="/profile-setup?edit=1&next=/daily-ledger"
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

      <section className="ledger-shell" aria-labelledby="ledger-title">
        <div className="import-hero ledger-hero">
          <div>
            <p className="dashboard-kicker">
              {activeLedgerMode === "income" ? "收入" : "應付款"}
            </p>
            <h1 id="ledger-title">每日收支</h1>
            <p>
              {activeLedgerMode === "income"
                ? "依分校、班級與學生處理繳費通知單；同一位學生的跨分校通知單會集中在 profile。"
                : "依分校與老師處理薪資單；發放完成後可在這裡更新狀態並列印。"}
            </p>
          </div>
          <span>{workspace.organization.name}</span>
        </div>

        <div className="ledger-mode-toggle no-print" aria-label="收支類型">
          {canRecordDailyLedger ? (
            <button
              aria-pressed={activeLedgerMode === "income"}
              className={activeLedgerMode === "income" ? "active" : ""}
              onClick={() => setLedgerMode("income")}
              type="button"
            >
              學生繳費
            </button>
          ) : null}
          {canViewPayroll ? (
            <button
              aria-pressed={activeLedgerMode === "payroll"}
              className={activeLedgerMode === "payroll" ? "active" : ""}
              onClick={() => setLedgerMode("payroll")}
              type="button"
            >
              老師薪資
            </button>
          ) : null}
        </div>

        <section className="branch-workspace-panel" aria-labelledby="ledger-branch-title">
          <div>
            <p className="dashboard-kicker">分校</p>
            <h2 id="ledger-branch-title">
              {selectedBranch ? selectedBranch.name : "請選擇分校"}
            </h2>
            <p>
              {activeLedgerMode === "income"
                ? "先切換分校，再依班級找到學生。"
                : "先切換分校，再找到老師薪資單。"}
            </p>
          </div>
          <div className="branch-switch-row" aria-label="選擇分校">
            {branchOptions.map((branch) => (
              <button
                aria-pressed={selectedBranch?.id === branch.id}
                className={selectedBranch?.id === branch.id ? "active" : ""}
                key={branch.id}
                onClick={() => {
                  setActiveBranchId(branch.id);
                  setActiveClassId(ALL_CLASSES);
                  setSelectedStudentId("");
                  setSelectedEmployeeId("");
                  setStatusMessage("");
                  setSalaryStatusMessage("");
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
            <p>建立分校與帳務資料後，這裡會顯示每日收支工作台。</p>
          </section>
        ) : null}

        {selectedBranch && activeLedgerMode === "income" ? (
          <>
            <div className="class-tab-row ledger-class-row" aria-label="班級">
              <button
                aria-pressed={activeClassId === ALL_CLASSES}
                className={activeClassId === ALL_CLASSES ? "active" : ""}
                onClick={() => {
                  setActiveClassId(ALL_CLASSES);
                  setSelectedStudentId("");
                }}
                type="button"
              >
                全部班級
                <span>{branchStudents.length}</span>
              </button>
              {classOptions.map((classRecord) => (
                <button
                  aria-pressed={activeClassId === classRecord.classId}
                  className={
                    activeClassId === classRecord.classId ? "active" : ""
                  }
                  key={classRecord.classId}
                  onClick={() => {
                    setActiveClassId(classRecord.classId);
                    setSelectedStudentId("");
                  }}
                  type="button"
                >
                  {classRecord.className}
                  <span>
                    {
                      branchStudents.filter((student) =>
                        belongsToClass(
                          student,
                          activeBranchId,
                          classRecord.classId,
                        ),
                      ).length
                    }
                  </span>
                </button>
              ))}
            </div>

            <section className="ledger-workspace-grid" aria-label="收入工作台">
              <aside className="ledger-student-panel">
                <div className="panel-heading ledger-panel-heading">
                  <div>
                    <p className="dashboard-kicker">學生</p>
                    <h2>{selectedBranch.name}</h2>
                  </div>
                  <span>{visibleStudents.length}</span>
                </div>

                {studentLoadStatus === "loading" ? (
                  <p className="ledger-state-note">正在載入學生帳戶...</p>
                ) : null}

                {studentLoadStatus === "error" ? (
                  <p className="ledger-state-note error">{studentLoadError}</p>
                ) : null}

                {studentLoadStatus === "ready" && !visibleStudents.length ? (
                  <p className="ledger-state-note">
                    目前沒有符合此分校與班級的學生。
                  </p>
                ) : null}

                <div className="ledger-student-list">
                  {visibleStudents.map((student) => {
                    const active = selectedStudent?.id === student.id;
                    const classBadges = getStudentClassBadges(
                      student,
                      activeBranchId,
                    );

                    return (
                      <button
                        aria-pressed={active}
                        className={`ledger-student-card ${active ? "active" : ""}`}
                        key={student.id}
                        onClick={() => setSelectedStudentId(student.id)}
                        type="button"
                      >
                        <span>{getPrimaryLegacyNumber(student)}</span>
                        <div>
                          <strong>{student.name || "未命名學生"}</strong>
                          <small>
                            {classBadges.map((record) => record.className).join("、") ||
                              "未分類"}
                          </small>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </aside>

              <section className="ledger-profile-panel">
                {selectedStudent ? (
                  <>
                    <div className="ledger-profile-heading">
                      <div>
                        <p className="dashboard-kicker">學生 profile</p>
                        <h2>{selectedStudent.name || "未命名學生"}</h2>
                        <div className="ledger-class-badge-row">
                          {getStudentClassBadges(
                            selectedStudent,
                            activeBranchId,
                          ).map((record) => (
                            <span key={record.classId}>{record.className}</span>
                          ))}
                        </div>
                      </div>
                      <em
                        className="ledger-student-id-badge"
                        title={`學生唯一 ID：${
                          selectedStudent.studentId || selectedStudent.id
                        }`}
                      >
                        ID{" "}
                        {getShortStudentId(
                          selectedStudent.studentId || selectedStudent.id,
                        )}
                      </em>
                    </div>

                    <div className="ledger-summary-grid" aria-label="學生收款摘要">
                      <article>
                        <span>舊編號</span>
                        <strong>{getPrimaryLegacyNumber(selectedStudent)}</strong>
                      </article>
                      <article>
                        <span>通知單</span>
                        <strong>{invoiceRecords.length}</strong>
                      </article>
                      <article>
                        <span>未收金額</span>
                        <strong>{formatCurrency(selectedStudentBalance)}</strong>
                      </article>
                      <article>
                        <span>已收金額</span>
                        <strong>{formatCurrency(selectedStudentPaidTotal)}</strong>
                      </article>
                    </div>

                    <section
                      className="ledger-payment-history"
                      aria-labelledby="student-payment-history-title"
                    >
                      <div className="ledger-payment-history-heading">
                        <div>
                          <p className="dashboard-kicker">收款紀錄</p>
                          <h3 id="student-payment-history-title">收據紀錄</h3>
                        </div>
                        <span>{paymentRecords.length} 筆</span>
                      </div>

                      {paymentLoadStatus === "loading" ? (
                        <p className="ledger-state-note">正在載入收款紀錄...</p>
                      ) : null}

                      {paymentLoadStatus === "error" ? (
                        <p className="ledger-state-note error">
                          {paymentLoadError}
                        </p>
                      ) : null}

                      {paymentLoadStatus === "ready" && !paymentRecords.length ? (
                        <p className="ledger-state-note">
                          此學生目前還沒有收款紀錄。
                        </p>
                      ) : null}

                      {paymentRecords.length ? (
                        <div className="ledger-payment-list">
                          {paymentRecords.slice(0, 6).map((payment) => (
                            <article className="ledger-payment-card" key={payment.id}>
                              <div>
                                <strong>{payment.receiptNumber || payment.id}</strong>
                                <p>
                                  {formatDateTime(payment.receivedAtIso)} ·{" "}
                                  {payment.receivedAtBranchSnapshot?.name ||
                                    "未記錄分校"}{" "}
                                  · {payment.receivedByName || "未記錄收款人"}
                                </p>
                              </div>
                              <span>{getPaymentMethodLabel(payment.method)}</span>
                              <strong>{formatCurrency(payment.amount)}</strong>
                              <button
                                className="table-action-button"
                                onClick={() => setPrintPayment(payment)}
                                type="button"
                              >
                                收據
                              </button>
                            </article>
                          ))}
                        </div>
                      ) : null}
                    </section>

                    <div className="ledger-status-filter" aria-label="通知單狀態">
                      <button
                        aria-pressed={statusFilter === ALL_STATUSES}
                        className={statusFilter === ALL_STATUSES ? "active" : ""}
                        onClick={() => setStatusFilter(ALL_STATUSES)}
                        type="button"
                      >
                        全部
                        <span>{invoiceCounts.all}</span>
                      </button>
                      {INVOICE_STATUS_OPTIONS.map((option) => (
                        <button
                          aria-pressed={statusFilter === option.value}
                          className={statusFilter === option.value ? "active" : ""}
                          key={option.value}
                          onClick={() => setStatusFilter(option.value)}
                          type="button"
                        >
                          {option.label}
                          <span>{invoiceCounts[option.value] || 0}</span>
                        </button>
                      ))}
                    </div>

                    {statusMessage ? (
                      <p
                        className={`ledger-state-note ${
                          statusMessage.includes("失敗") ? "error" : "success"
                        }`}
                      >
                        {statusMessage}
                      </p>
                    ) : null}

                    {invoiceLoadStatus === "loading" ? (
                      <p className="ledger-state-note">正在載入繳費通知單...</p>
                    ) : null}

                    {invoiceLoadStatus === "error" ? (
                      <p className="ledger-state-note error">{invoiceLoadError}</p>
                    ) : null}

                    {invoiceLoadStatus === "ready" && !invoiceRecords.length ? (
                      <p className="ledger-state-note">
                        此學生目前沒有已產生的繳費通知單。
                      </p>
                    ) : null}

                    {invoiceRecords.length && !filteredInvoices.length ? (
                      <p className="ledger-state-note">
                        此狀態目前沒有通知單。
                      </p>
                    ) : null}

                    <div className="ledger-invoice-list">
                      {filteredInvoices.map((invoice) => (
                        <article className="ledger-invoice-card" key={invoice.id}>
                          <div className="ledger-invoice-heading">
                            <div>
                              <strong>{invoice.invoiceNumber || invoice.id}</strong>
                              <p>
                                {invoice.sourceBranchSnapshot?.name || "未記錄分校"} ·{" "}
                                {invoice.className || "未記錄班級"} ·{" "}
                                {formatDateTime(invoice.issuedAtIso)}
                              </p>
                            </div>
                            <em
                              className={`invoice-status-chip ${getInvoiceStatus(
                                invoice,
                              )}`}
                            >
                              {getInvoiceStatusLabel(invoice.status)}
                            </em>
                          </div>

                          <div className="ledger-invoice-amount-grid">
                            <span>
                              應繳
                              <strong>{formatCurrency(invoice.total)}</strong>
                            </span>
                            <span>
                              已收
                              <strong>{formatCurrency(invoice.paidTotal)}</strong>
                            </span>
                            <span>
                              未收
                              <strong>
                                {formatCurrency(invoice.balance ?? invoice.total)}
                              </strong>
                            </span>
                          </div>

                          <div className="ledger-invoice-lines">
                            {(invoice.lineItems || []).slice(0, 4).map((line) => (
                              <span key={line.id}>
                                {line.name} · {formatCurrency(line.amount)}
                              </span>
                            ))}
                            {(invoice.lineItems || []).length > 4 ? (
                              <span>
                                另有 {(invoice.lineItems || []).length - 4} 項
                              </span>
                            ) : null}
                          </div>

                          <div className="ledger-invoice-actions">
                            <label>
                              狀態
                              <select
                                disabled={
                                  updatingInvoiceId === invoice.id ||
                                  paymentSaveStatus === "saving"
                                }
                                onChange={(event) =>
                                  handleStatusChange(invoice, event.target.value)
                                }
                                value={getInvoiceStatus(invoice)}
                              >
                                {INVOICE_STATUS_OPTIONS.map((option) => (
                                  <option key={option.value} value={option.value}>
                                    {option.label}
                                  </option>
                                ))}
                              </select>
                            </label>
                            {getInvoiceAmount(invoice) > 0 &&
                            getInvoiceStatus(invoice) !== "void" ? (
                              <button
                                className="table-action-button primary"
                                onClick={() => openPaymentModal(invoice)}
                                type="button"
                              >
                                收款
                              </button>
                            ) : null}
                            <button
                              className="table-action-button"
                              onClick={() => setPrintInvoice(invoice)}
                              type="button"
                            >
                              通知單
                            </button>
                          </div>
                        </article>
                      ))}
                    </div>
                  </>
                ) : (
                  <div className="ledger-empty-profile">
                    <p className="dashboard-kicker">學生 profile</p>
                    <h2>尚未選擇學生</h2>
                    <p>選擇分校與班級後，學生的繳費通知單會顯示在這裡。</p>
                  </div>
                )}
              </section>
            </section>
          </>
        ) : null}

        {selectedBranch && activeLedgerMode === "payroll" ? (
          <section className="ledger-workspace-grid" aria-label="老師薪資工作台">
            <aside className="ledger-student-panel">
              <div className="panel-heading ledger-panel-heading">
                <div>
                  <p className="dashboard-kicker">老師</p>
                  <h2>{selectedBranch.name}</h2>
                </div>
                <span>{branchEmployees.length}</span>
              </div>

              {employeeLoadStatus === "loading" ? (
                <p className="ledger-state-note">正在載入老師帳戶...</p>
              ) : null}

              {employeeLoadStatus === "error" ? (
                <p className="ledger-state-note error">{employeeLoadError}</p>
              ) : null}

              {employeeLoadStatus === "ready" && !branchEmployees.length ? (
                <p className="ledger-state-note">目前沒有此分校的老師。</p>
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
                      onClick={() => setSelectedEmployeeId(employee.id)}
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

            <section className="ledger-profile-panel">
              {selectedEmployee ? (
                <>
                  <div className="ledger-profile-heading">
                    <div>
                      <p className="dashboard-kicker">老師 profile</p>
                      <h2>{selectedEmployee.name || "未命名老師"}</h2>
                      <div className="ledger-class-badge-row">
                        <span>{selectedBranch.name}</span>
                        <span>
                          {getPayrollTypeLabel(selectedEmployee.compensationType)}
                        </span>
                      </div>
                    </div>
                    <em className="ledger-student-id-badge">
                      {branchSalarySlips.length} 張薪資單
                    </em>
                  </div>

                  <div className="ledger-summary-grid" aria-label="老師薪資摘要">
                    <article>
                      <span>計薪方式</span>
                      <strong>
                        {getPayrollTypeLabel(selectedEmployee.compensationType)}
                      </strong>
                    </article>
                    <article>
                      <span>薪資單</span>
                      <strong>{branchSalarySlips.length}</strong>
                    </article>
                    <article>
                      <span>未發放</span>
                      <strong>{formatCurrency(selectedEmployeeUnpaidTotal)}</strong>
                    </article>
                  </div>

                  <div className="ledger-status-filter" aria-label="薪資單狀態">
                    <button
                      aria-pressed={salaryStatusFilter === ALL_STATUSES}
                      className={
                        salaryStatusFilter === ALL_STATUSES ? "active" : ""
                      }
                      onClick={() => setSalaryStatusFilter(ALL_STATUSES)}
                      type="button"
                    >
                      全部
                      <span>{salarySlipCounts.all}</span>
                    </button>
                    {SALARY_STATUS_OPTIONS.map((option) => (
                      <button
                        aria-pressed={salaryStatusFilter === option.value}
                        className={
                          salaryStatusFilter === option.value ? "active" : ""
                        }
                        key={option.value}
                        onClick={() => setSalaryStatusFilter(option.value)}
                        type="button"
                      >
                        {option.label}
                        <span>{salarySlipCounts[option.value] || 0}</span>
                      </button>
                    ))}
                  </div>

                  {salaryStatusMessage ? (
                    <p
                      className={`ledger-state-note ${
                        salaryStatusMessage.includes("失敗")
                          ? "error"
                          : "success"
                      }`}
                    >
                      {salaryStatusMessage}
                    </p>
                  ) : null}

                  {salarySlipLoadStatus === "loading" ? (
                    <p className="ledger-state-note">正在載入薪資單...</p>
                  ) : null}

                  {salarySlipLoadStatus === "error" ? (
                    <p className="ledger-state-note error">
                      {salarySlipLoadError}
                    </p>
                  ) : null}

                  {salarySlipLoadStatus === "ready" &&
                  !branchSalarySlips.length ? (
                    <p className="ledger-state-note">
                      此老師目前沒有已產生的薪資單。
                    </p>
                  ) : null}

                  {branchSalarySlips.length && !filteredSalarySlips.length ? (
                    <p className="ledger-state-note">此狀態目前沒有薪資單。</p>
                  ) : null}

                  <div className="ledger-invoice-list">
                    {filteredSalarySlips.map((salarySlip) => (
                      <article
                        className="ledger-invoice-card salary-slip-card"
                        key={salarySlip.id}
                      >
                        <div className="ledger-invoice-heading">
                          <div>
                            <strong>
                              {salarySlip.salarySlipNumber || salarySlip.id}
                            </strong>
                            <p>
                              {salarySlip.branchSnapshot?.name || "未記錄分校"} ·{" "}
                              {getPayrollTypeLabel(salarySlip.payrollType)} ·{" "}
                              {formatDateTime(salarySlip.issuedAtIso)}
                            </p>
                          </div>
                          <em
                            className={`invoice-status-chip ${getSalarySlipStatus(
                              salarySlip,
                            )}`}
                          >
                            {getSalarySlipStatusLabel(salarySlip.status)}
                          </em>
                        </div>

                        <div className="ledger-invoice-amount-grid">
                          <span>
                            應發
                            <strong>{formatCurrency(salarySlip.total)}</strong>
                          </span>
                          <span>
                            已發
                            <strong>{formatCurrency(salarySlip.paidTotal)}</strong>
                          </span>
                          <span>
                            未發
                            <strong>
                              {formatCurrency(
                                salarySlip.balance ?? salarySlip.total,
                              )}
                            </strong>
                          </span>
                        </div>

                        <div className="ledger-invoice-lines">
                          {(salarySlip.lineItems || []).slice(0, 4).map((line) => (
                            <span key={line.id}>
                              {line.name} · {formatCurrency(line.amount)}
                            </span>
                          ))}
                          {(salarySlip.lineItems || []).length > 4 ? (
                            <span>
                              另有 {(salarySlip.lineItems || []).length - 4} 項
                            </span>
                          ) : null}
                        </div>

                        <div className="ledger-invoice-actions">
                          <label>
                            狀態
                            <select
                              disabled={updatingSalarySlipId === salarySlip.id}
                              onChange={(event) =>
                                handleSalaryStatusChange(
                                  salarySlip,
                                  event.target.value,
                                )
                              }
                              value={getSalarySlipStatus(salarySlip)}
                            >
                              {SALARY_STATUS_OPTIONS.map((option) => (
                                <option key={option.value} value={option.value}>
                                  {option.label}
                                </option>
                              ))}
                            </select>
                          </label>
                          <button
                            className="table-action-button"
                            onClick={() => setPrintSalarySlip(salarySlip)}
                            type="button"
                          >
                            列印
                          </button>
                        </div>
                      </article>
                    ))}
                  </div>
                </>
              ) : (
                <div className="ledger-empty-profile">
                  <p className="dashboard-kicker">老師 profile</p>
                  <h2>尚未選擇老師</h2>
                  <p>到老師薪資建立老師與薪資單後，這裡會顯示發放狀態。</p>
                </div>
              )}
            </section>
          </section>
        ) : null}
      </section>

      {paymentTargetInvoice ? (
        <div className="invoice-modal-backdrop" onClick={closePaymentModal}>
          <section
            aria-labelledby="payment-modal-title"
            aria-modal="true"
            className="invoice-preview-modal payment-modal"
            onClick={(event) => event.stopPropagation()}
            role="dialog"
          >
            <div className="invoice-modal-heading">
              <div>
                <p className="dashboard-kicker">收款</p>
                <h2 id="payment-modal-title">建立收款紀錄</h2>
                <p>{paymentTargetInvoice.invoiceNumber || paymentTargetInvoice.id}</p>
              </div>
              <button
                className="modal-close-icon"
                onClick={closePaymentModal}
                type="button"
              >
                關閉
              </button>
            </div>

            <div className="payment-modal-summary">
              <span>
                學生
                <strong>{selectedStudent?.name || "未命名學生"}</strong>
              </span>
              <span>
                通知單分校
                <strong>
                  {paymentTargetInvoice.sourceBranchSnapshot?.name || "未記錄"}
                </strong>
              </span>
              <span>
                收款分校
                <strong>{selectedBranch?.name || "未記錄"}</strong>
              </span>
              <span>
                收款人
                <strong>{getCurrentUserDisplayName(workspace, currentUser)}</strong>
              </span>
              <span>
                未收金額
                <strong>{formatCurrency(getInvoiceAmount(paymentTargetInvoice))}</strong>
              </span>
            </div>

            <form className="payment-form" onSubmit={handlePaymentSubmit}>
              <label>
                收款金額
                <input
                  min="1"
                  max={getInvoiceAmount(paymentTargetInvoice)}
                  onChange={(event) =>
                    setPaymentForm((current) => ({
                      ...current,
                      amount: event.target.value,
                    }))
                  }
                  type="number"
                  value={paymentForm.amount}
                />
              </label>
              <label>
                付款方式
                <select
                  onChange={(event) =>
                    setPaymentForm((current) => ({
                      ...current,
                      method: event.target.value,
                    }))
                  }
                  value={paymentForm.method}
                >
                  {PAYMENT_METHOD_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="payment-form-full">
                備註
                <textarea
                  onChange={(event) =>
                    setPaymentForm((current) => ({
                      ...current,
                      note: event.target.value,
                    }))
                  }
                  placeholder="例如：二校櫃台代收、家長現金繳清"
                  rows="3"
                  value={paymentForm.note}
                />
              </label>

              {paymentError ? (
                <p className="ledger-state-note error payment-form-full">
                  {paymentError}
                </p>
              ) : null}

              <div className="invoice-modal-actions payment-form-full">
                <button disabled={paymentSaveStatus === "saving"} type="submit">
                  {paymentSaveStatus === "saving" ? "儲存中..." : "確認收款並開收據"}
                </button>
                <button
                  className="secondary-modal-button"
                  onClick={closePaymentModal}
                  type="button"
                >
                  取消
                </button>
              </div>
            </form>
          </section>
        </div>
      ) : null}

      {printInvoice ? (
        <div
          className="invoice-modal-backdrop"
          onClick={() => setPrintInvoice(null)}
        >
          <section
            aria-labelledby="ledger-print-title"
            aria-modal="true"
            className="invoice-preview-modal ledger-print-modal"
            onClick={(event) => event.stopPropagation()}
            role="dialog"
          >
            <div className="invoice-modal-heading no-print">
              <div>
                <p className="dashboard-kicker">列印</p>
                <h2 id="ledger-print-title">繳費通知單</h2>
                <p>{printInvoice.invoiceNumber || printInvoice.id}</p>
              </div>
              <button
                className="modal-close-icon"
                onClick={() => setPrintInvoice(null)}
                type="button"
              >
                關閉
              </button>
            </div>
            {renderInvoicePrint(printInvoice)}
            <div className="invoice-modal-actions no-print">
              <button onClick={() => window.print()} type="button">
                列印
              </button>
              <button
                className="secondary-modal-button"
                onClick={() => setPrintInvoice(null)}
                type="button"
              >
                取消
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {printPayment ? (
        <div
          className="invoice-modal-backdrop"
          onClick={() => setPrintPayment(null)}
        >
          <section
            aria-labelledby="receipt-print-title"
            aria-modal="true"
            className="invoice-preview-modal ledger-print-modal"
            onClick={(event) => event.stopPropagation()}
            role="dialog"
          >
            <div className="invoice-modal-heading no-print">
              <div>
                <p className="dashboard-kicker">列印</p>
                <h2 id="receipt-print-title">收據</h2>
                <p>{printPayment.receiptNumber || printPayment.id}</p>
              </div>
              <button
                className="modal-close-icon"
                onClick={() => setPrintPayment(null)}
                type="button"
              >
                關閉
              </button>
            </div>
            {renderPaymentReceipt(printPayment)}
            <div className="invoice-modal-actions no-print">
              <button onClick={() => window.print()} type="button">
                列印
              </button>
              <button
                className="secondary-modal-button"
                onClick={() => setPrintPayment(null)}
                type="button"
              >
                取消
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {printSalarySlip ? (
        <div
          className="invoice-modal-backdrop"
          onClick={() => setPrintSalarySlip(null)}
        >
          <section
            aria-labelledby="salary-print-title"
            aria-modal="true"
            className="invoice-preview-modal ledger-print-modal"
            onClick={(event) => event.stopPropagation()}
            role="dialog"
          >
            <div className="invoice-modal-heading no-print">
              <div>
                <p className="dashboard-kicker">列印</p>
                <h2 id="salary-print-title">老師薪資單</h2>
                <p>{printSalarySlip.salarySlipNumber || printSalarySlip.id}</p>
              </div>
              <button
                className="modal-close-icon"
                onClick={() => setPrintSalarySlip(null)}
                type="button"
              >
                關閉
              </button>
            </div>
            {renderSalarySlipPrint(printSalarySlip)}
            <div className="invoice-modal-actions no-print">
              <button onClick={() => window.print()} type="button">
                列印
              </button>
              <button
                className="secondary-modal-button"
                onClick={() => setPrintSalarySlip(null)}
                type="button"
              >
                取消
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );
}

export default DailyLedgerPage;

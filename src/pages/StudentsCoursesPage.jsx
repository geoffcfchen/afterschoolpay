import { useEffect, useMemo, useRef, useState } from "react";
import { onAuthStateChanged, signOut } from "firebase/auth";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { auth } from "../lib/firebase";
import {
  loadCurrentBillingWorkspace,
  saveCurrentBillingWorkspace,
} from "../lib/billingWorkspaceData";
import { loadOrganizationWorkspace } from "../lib/orgData";
import { organizeTuitionBagFile } from "../lib/tuitionBagImport";

const EMPTY_FEE_FORM = {
  code: "",
  name: "",
  amount: "",
  details: "",
};
const DOUBLE_COURSE_DISCOUNT_CODE = "AUTO-DOUBLE-COURSE";
const DOUBLE_COURSE_DISCOUNT_OPTION = {
  id: "fee-auto-double-course",
  rowNumber: 0,
  code: DOUBLE_COURSE_DISCOUNT_CODE,
  name: "雙科優惠",
  rawName: "雙科優惠",
  amount: -200,
  details: [
    {
      column: "自動",
      value: "數學與英文皆為完整堂數時自動套用，可手動取消",
    },
  ],
  automatic: true,
};

function getWorkspaceErrorMessage(error) {
  if (error.code === "permission-denied") {
    return "Firestore 拒絕讀取工作區。請先發布 Firestore rules，並確認你的權限。";
  }

  return "帳號已登入，但目前無法載入學生與課程工作區。";
}

function formatFileSize(size) {
  if (!size) {
    return "";
  }

  if (size < 1024 * 1024) {
    return `${Math.round(size / 1024)} KB`;
  }

  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function formatCurrency(amount) {
  return `${amount.toLocaleString()} 元`;
}

function formatDateShort(date) {
  const [, month, day] = date.split("-");
  return `${Number(month)}/${Number(day)}`;
}

function sortDates(dates) {
  return [...new Set(dates)].sort((a, b) => a.localeCompare(b));
}

function getFeeDetailsText(option) {
  return option.details?.map((detail) => detail.value).join(" / ") || "";
}

function getCourseAmount(course, dates) {
  const sessionCount = dates.length;

  if (sessionCount === 0) {
    return 0;
  }

  if (course.subjectCode === "理" || course.label.includes("理化")) {
    return sessionCount * 400;
  }

  if (course.label.includes("英檢")) {
    return sessionCount * 315;
  }

  return sessionCount * 275;
}

function compareFeeOptions(a, b) {
  const aNumber = Number(a.code);
  const bNumber = Number(b.code);

  if (Number.isFinite(aNumber) && Number.isFinite(bNumber)) {
    return aNumber - bNumber;
  }

  if (Number.isFinite(aNumber)) {
    return -1;
  }

  if (Number.isFinite(bNumber)) {
    return 1;
  }

  return a.code.localeCompare(b.code);
}

function withAutomaticFeeOptions(feeItems) {
  if (feeItems.some((item) => item.code === DOUBLE_COURSE_DISCOUNT_CODE)) {
    return feeItems;
  }

  return [...feeItems, DOUBLE_COURSE_DISCOUNT_OPTION];
}

function qualifiesForDoubleCourseDiscount(sheet, row) {
  const fullSubjects = new Set();

  sheet.courseBlocks.forEach((course) => {
    const dates = row.courseDates[course.id] || [];
    const amount = getCourseAmount(course, dates);

    if (
      ["數", "英"].includes(course.subjectCode) &&
      dates.length >= 8 &&
      amount >= 2200
    ) {
      fullSubjects.add(course.subjectCode);
    }
  });

  return fullSubjects.has("數") && fullSubjects.has("英");
}

function qualifiesForDoubleCourseDiscountFromDraft(sheet, row, classDraft) {
  const fullSubjects = new Set();

  sheet.courseBlocks.forEach((course) => {
    const dates = classDraft.studentDates[row.id]?.[course.id] || [];
    const amount = getCourseAmount(course, dates);

    if (
      ["數", "英"].includes(course.subjectCode) &&
      dates.length >= 8 &&
      amount >= 2200
    ) {
      fullSubjects.add(course.subjectCode);
    }
  });

  return fullSubjects.has("數") && fullSubjects.has("英");
}

function reconcileAutomaticDiscounts(sheet, classDraft, dismissedRowIds) {
  if (!sheet) {
    return classDraft;
  }

  const dismissedRows = new Set(dismissedRowIds);

  return {
    ...classDraft,
    studentFeeCodes: Object.fromEntries(
      sheet.studentRows.map((row) => {
        const feeCodes = (classDraft.studentFeeCodes[row.id] || []).filter(
          (code) => code !== DOUBLE_COURSE_DISCOUNT_CODE,
        );

        if (
          qualifiesForDoubleCourseDiscountFromDraft(sheet, row, classDraft) &&
          !dismissedRows.has(row.id)
        ) {
          feeCodes.push(DOUBLE_COURSE_DISCOUNT_CODE);
        }

        return [row.id, feeCodes];
      }),
    ),
  };
}

function createInvoiceState(importResult) {
  return {
    classes: Object.fromEntries(
      importResult.classSheets.map((sheet) => [
        sheet.id,
        {
          globalDates: Object.fromEntries(
            sheet.courseBlocks.map((course) => [course.id, course.globalDates]),
          ),
          studentDates: Object.fromEntries(
            sheet.studentRows.map((row) => [
              row.id,
              Object.fromEntries(
                sheet.courseBlocks.map((course) => [
                  course.id,
                  row.courseDates[course.id] || [],
                ]),
              ),
            ]),
          ),
          studentFeeCodes: Object.fromEntries(
            sheet.studentRows.map((row) => {
              const feeCodes = row.feeReferences.map((fee) => fee.code);

              if (
                qualifiesForDoubleCourseDiscount(sheet, row) &&
                !feeCodes.includes(DOUBLE_COURSE_DISCOUNT_CODE)
              ) {
                feeCodes.push(DOUBLE_COURSE_DISCOUNT_CODE);
              }

              return [row.id, feeCodes];
            }),
          ),
          studentCustomFees: Object.fromEntries(
            sheet.studentRows.map((row) => [row.id, row.customFees]),
          ),
        },
      ]),
    ),
  };
}

function calculateInvoice(row, sheet, classDraft, feeOptionsByCode) {
  const courseLines = sheet.courseBlocks.map((course) => {
    const dates = classDraft?.studentDates[row.id]?.[course.id] || [];

    return {
      id: course.id,
      label: course.label,
      subjectCode: course.subjectCode,
      dates,
      sessionCount: dates.length,
      amount: getCourseAmount(course, dates),
    };
  });
  const feeCodes = classDraft?.studentFeeCodes[row.id] || [];
  const feeLines = feeCodes
    .map((code) => feeOptionsByCode.get(code))
    .filter(Boolean)
    .map((fee) => ({
      id: `fee-${fee.code}`,
      label: fee.name,
      code: fee.code,
      amount: fee.amount,
      details: getFeeDetailsText(fee),
    }));
  const customFeeLines = classDraft?.studentCustomFees[row.id] || [];
  const courseTotal = courseLines.reduce((total, line) => total + line.amount, 0);
  const feeTotal = [...feeLines, ...customFeeLines].reduce(
    (total, line) => total + line.amount,
    0,
  );

  return {
    courseLines,
    feeLines,
    customFeeLines,
    total: courseTotal + feeTotal,
  };
}

function UploadStep({ active, children, complete, title }) {
  return (
    <article
      className={`import-step ${active ? "active" : ""} ${
        complete ? "complete" : ""
      }`}
    >
      <span aria-hidden="true" />
      <div>
        <h3>{title}</h3>
        <p>{children}</p>
      </div>
    </article>
  );
}

function StudentsCoursesPage() {
  const navigate = useNavigate();
  const inputRef = useRef(null);
  const savedLoadStartedRef = useRef(false);
  const [authStatus, setAuthStatus] = useState(auth ? "checking" : "error");
  const [currentUser, setCurrentUser] = useState(null);
  const [workspace, setWorkspace] = useState(null);
  const [loadError, setLoadError] = useState(
    auth ? "" : "這個版本尚未設定 Firebase。",
  );
  const [dragging, setDragging] = useState(false);
  const [importStatus, setImportStatus] = useState("idle");
  const [importError, setImportError] = useState("");
  const [result, setResult] = useState(null);
  const [activeClassId, setActiveClassId] = useState("");
  const [invoiceState, setInvoiceState] = useState(null);
  const [feeOptions, setFeeOptions] = useState([]);
  const [feeForm, setFeeForm] = useState(EMPTY_FEE_FORM);
  const [editingFeeCode, setEditingFeeCode] = useState("");
  const [dateDrafts, setDateDrafts] = useState({});
  const [selectedInvoiceRowId, setSelectedInvoiceRowId] = useState("");
  const [dismissedDoubleCourseRows, setDismissedDoubleCourseRows] = useState([]);
  const [savedLoadStatus, setSavedLoadStatus] = useState("idle");
  const [savedWorkspace, setSavedWorkspace] = useState(null);
  const [saveStatus, setSaveStatus] = useState("idle");
  const [saveError, setSaveError] = useState("");
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);

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
        console.error("Unable to load students workspace:", error);

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

  const canViewStudents = workspace?.member?.permissions?.canViewStudents;
  const selectedClassSheet = useMemo(() => {
    if (!result?.classSheets.length) {
      return null;
    }

    return (
      result.classSheets.find((sheet) => sheet.id === activeClassId) ||
      result.classSheets[0]
    );
  }, [activeClassId, result]);
  const selectedClassDraft = selectedClassSheet
    ? invoiceState?.classes[selectedClassSheet.id]
    : null;
  const feeOptionsByCode = useMemo(
    () => new Map(feeOptions.map((option) => [option.code, option])),
    [feeOptions],
  );
  const invoiceRows = useMemo(() => {
    if (!selectedClassSheet || !selectedClassDraft) {
      return [];
    }

    return selectedClassSheet.studentRows.map((row) => ({
      ...row,
      invoice: calculateInvoice(
        row,
        selectedClassSheet,
        selectedClassDraft,
        feeOptionsByCode,
      ),
    }));
  }, [feeOptionsByCode, selectedClassDraft, selectedClassSheet]);
  const selectedInvoiceRow =
    invoiceRows.find((row) => row.id === selectedInvoiceRowId) ||
    invoiceRows[0];
  const workspaceTotals = useMemo(
    () => ({
      activeClassTotal: invoiceRows.reduce(
        (total, row) => total + row.invoice.total,
        0,
      ),
      courseCount: selectedClassSheet?.courseBlocks.length || 0,
      feeOptionCount: feeOptions.length,
      invoiceCount: invoiceRows.length,
    }),
    [feeOptions.length, invoiceRows, selectedClassSheet],
  );

  useEffect(() => {
    if (
      authStatus !== "ready" ||
      !canViewStudents ||
      result ||
      importStatus !== "idle" ||
      savedLoadStartedRef.current
    ) {
      return undefined;
    }

    let active = true;
    savedLoadStartedRef.current = true;

    Promise.resolve()
      .then(() => {
        if (active) {
          setSavedLoadStatus("loading");
        }

        return loadCurrentBillingWorkspace();
      })
      .then((saved) => {
        if (!active) {
          return;
        }

        if (saved) {
          const firstClass = saved.result.classSheets[0];
          const activeClass =
            saved.result.classSheets.find(
              (sheet) => sheet.id === saved.activeClassId,
            ) || firstClass;
          const firstRow = activeClass?.studentRows[0];

          setResult(saved.result);
          setInvoiceState(saved.invoiceState);
          setFeeOptions(withAutomaticFeeOptions(saved.feeOptions));
          setActiveClassId(activeClass?.id || "");
          setSelectedInvoiceRowId(saved.selectedInvoiceRowId || firstRow?.id || "");
          setDismissedDoubleCourseRows(saved.dismissedDoubleCourseRows);
          setSavedWorkspace(saved);
          setSaveStatus("saved");
          setHasUnsavedChanges(false);
          setImportStatus("ready");
        }

        setSavedLoadStatus("ready");
      })
      .catch((error) => {
        console.error("Unable to load saved billing workspace:", error);

        if (active) {
          setSavedLoadStatus("error");
        }
      });

    return () => {
      active = false;
    };
  }, [
    authStatus,
    canViewStudents,
    importStatus,
    result,
  ]);

  const markWorkspaceDirty = () => {
    setHasUnsavedChanges(true);
    setSaveStatus("idle");
    setSaveError("");
  };

  const updateSelectedClassDraft = (updater) => {
    if (!selectedClassSheet) {
      return;
    }

    setInvoiceState((current) => {
      if (!current) {
        return current;
      }

      const classDraft = current.classes[selectedClassSheet.id];

      return {
        ...current,
        classes: {
          ...current.classes,
          [selectedClassSheet.id]: updater(classDraft),
        },
      };
    });
  };

  const handleSignOut = async () => {
    if (!auth) {
      return;
    }

    await signOut(auth);
    navigate("/");
  };

  const handleFile = async (file) => {
    setImportError("");
    setResult(null);
    setInvoiceState(null);
    setFeeOptions([]);
    setActiveClassId("");
    setSelectedInvoiceRowId("");
    setDismissedDoubleCourseRows([]);
    setSavedWorkspace(null);
    setSaveStatus("idle");
    setSaveError("");
    setHasUnsavedChanges(false);

    if (!file) {
      return;
    }

    if (!/\.xlsx$/i.test(file.name)) {
      setImportError("請上傳 Excel 檔案（.xlsx）。");
      setImportStatus("idle");
      return;
    }

    try {
      setImportStatus("parsing");
      const organized = await organizeTuitionBagFile(file);
      const firstClass = organized.classSheets[0];
      const firstRow = firstClass?.studentRows[0];

      setResult(organized);
      setInvoiceState(createInvoiceState(organized));
      setFeeOptions(withAutomaticFeeOptions(organized.feeItems));
      setActiveClassId(firstClass?.id || "");
      setSelectedInvoiceRowId(firstRow?.id || "");
      setImportStatus("ready");
      setHasUnsavedChanges(true);
    } catch (error) {
      console.error("Unable to organize tuition bag:", error);
      setImportError("無法解析這份 Excel。請確認檔案格式是否為學費袋。");
      setImportStatus("idle");
    }
  };

  const handleDrop = (event) => {
    event.preventDefault();
    setDragging(false);
    handleFile(event.dataTransfer.files?.[0]);
  };

  const handleSaveWorkspace = async () => {
    if (!result || !invoiceState || saveStatus === "saving") {
      return;
    }

    setSaveStatus("saving");
    setSaveError("");

    try {
      const saved = await saveCurrentBillingWorkspace({
        activeClassId,
        dismissedDoubleCourseRows,
        feeOptions,
        invoiceState,
        result,
        savedByUid: currentUser?.uid,
        selectedInvoiceRowId: selectedInvoiceRow?.id || selectedInvoiceRowId,
      });

      setSavedWorkspace(saved);
      setHasUnsavedChanges(false);
      setSaveStatus("saved");
    } catch (error) {
      console.error("Unable to save billing workspace:", error);
      setSaveError("無法儲存到系統。請確認網路與 Firestore 權限後再試一次。");
      setSaveStatus("error");
    }
  };

  const addGlobalDate = (courseId) => {
    const date = dateDrafts[courseId];

    if (!date) {
      return;
    }

    markWorkspaceDirty();
    updateSelectedClassDraft((classDraft) => {
      const nextDraft = {
        ...classDraft,
        globalDates: {
          ...classDraft.globalDates,
          [courseId]: sortDates([
            ...(classDraft.globalDates[courseId] || []),
            date,
          ]),
        },
        studentDates: Object.fromEntries(
          Object.entries(classDraft.studentDates).map(([rowId, courses]) => [
            rowId,
            {
              ...courses,
              [courseId]: sortDates([...(courses[courseId] || []), date]),
            },
          ]),
        ),
      };

      return reconcileAutomaticDiscounts(
        selectedClassSheet,
        nextDraft,
        dismissedDoubleCourseRows,
      );
    });
    setDateDrafts((current) => ({ ...current, [courseId]: "" }));
  };

  const removeGlobalDate = (courseId, date) => {
    markWorkspaceDirty();
    updateSelectedClassDraft((classDraft) => {
      const nextDraft = {
        ...classDraft,
        globalDates: {
          ...classDraft.globalDates,
          [courseId]: (classDraft.globalDates[courseId] || []).filter(
            (item) => item !== date,
          ),
        },
        studentDates: Object.fromEntries(
          Object.entries(classDraft.studentDates).map(([rowId, courses]) => [
            rowId,
            {
              ...courses,
              [courseId]: (courses[courseId] || []).filter(
                (item) => item !== date,
              ),
            },
          ]),
        ),
      };

      return reconcileAutomaticDiscounts(
        selectedClassSheet,
        nextDraft,
        dismissedDoubleCourseRows,
      );
    });
  };

  const toggleStudentDate = (rowId, courseId, date) => {
    markWorkspaceDirty();
    updateSelectedClassDraft((classDraft) => {
      const rowDates = classDraft.studentDates[rowId]?.[courseId] || [];
      const nextDates = rowDates.includes(date)
        ? rowDates.filter((item) => item !== date)
        : sortDates([...rowDates, date]);

      const nextDraft = {
        ...classDraft,
        studentDates: {
          ...classDraft.studentDates,
          [rowId]: {
            ...classDraft.studentDates[rowId],
            [courseId]: nextDates,
          },
        },
      };

      return reconcileAutomaticDiscounts(
        selectedClassSheet,
        nextDraft,
        dismissedDoubleCourseRows,
      );
    });
  };

  const addStudentFee = (rowId, code) => {
    if (!code) {
      return;
    }

    markWorkspaceDirty();
    if (code === DOUBLE_COURSE_DISCOUNT_CODE) {
      setDismissedDoubleCourseRows((current) =>
        current.filter((row) => row !== rowId),
      );
    }

    updateSelectedClassDraft((classDraft) => {
      const currentCodes = classDraft.studentFeeCodes[rowId] || [];

      if (currentCodes.includes(code)) {
        return classDraft;
      }

      return {
        ...classDraft,
        studentFeeCodes: {
          ...classDraft.studentFeeCodes,
          [rowId]: [...currentCodes, code],
        },
      };
    });
  };

  const removeStudentFee = (rowId, code) => {
    markWorkspaceDirty();
    if (code === DOUBLE_COURSE_DISCOUNT_CODE) {
      setDismissedDoubleCourseRows((current) =>
        current.includes(rowId) ? current : [...current, rowId],
      );
    }

    updateSelectedClassDraft((classDraft) => ({
      ...classDraft,
      studentFeeCodes: {
        ...classDraft.studentFeeCodes,
        [rowId]: (classDraft.studentFeeCodes[rowId] || []).filter(
          (item) => item !== code,
        ),
      },
    }));
  };

  const handleFeeFormChange = (event) => {
    const { name, value } = event.target;
    setFeeForm((current) => ({ ...current, [name]: value }));
  };

  const resetFeeForm = () => {
    setFeeForm(EMPTY_FEE_FORM);
    setEditingFeeCode("");
  };

  const handleFeeSubmit = (event) => {
    event.preventDefault();
    const code = feeForm.code.trim();
    const name = feeForm.name.trim();

    if (!code || !name) {
      return;
    }

    markWorkspaceDirty();
    const nextOption = {
      id: `fee-option-${code}`,
      rowNumber:
        feeOptions.find((option) => option.code === code)?.rowNumber ||
        feeOptions.length + 1,
      code,
      name,
      rawName: name,
      amount: Number(feeForm.amount) || 0,
      details: feeForm.details.trim()
        ? [{ column: "備註", value: feeForm.details.trim() }]
        : [],
    };

    setFeeOptions((current) => {
      const withoutEdited = current.filter(
        (option) => option.code !== editingFeeCode && option.code !== code,
      );

      return [...withoutEdited, nextOption].sort(compareFeeOptions);
    });

    if (editingFeeCode && editingFeeCode !== code) {
      setInvoiceState((current) => {
        if (!current) {
          return current;
        }

        return {
          ...current,
          classes: Object.fromEntries(
            Object.entries(current.classes).map(([classId, classDraft]) => [
              classId,
              {
                ...classDraft,
                studentFeeCodes: Object.fromEntries(
                  Object.entries(classDraft.studentFeeCodes).map(
                    ([rowId, codes]) => [
                      rowId,
                      codes.map((item) =>
                        item === editingFeeCode ? code : item,
                      ),
                    ],
                  ),
                ),
              },
            ]),
          ),
        };
      });
    }

    resetFeeForm();
  };

  const editFeeOption = (option) => {
    setEditingFeeCode(option.code);
    setFeeForm({
      code: option.code,
      name: option.name,
      amount: String(option.amount),
      details: getFeeDetailsText(option),
    });
  };

  const deleteFeeOption = (code) => {
    markWorkspaceDirty();
    setFeeOptions((current) => current.filter((option) => option.code !== code));
    setInvoiceState((current) => {
      if (!current) {
        return current;
      }

      return {
        ...current,
        classes: Object.fromEntries(
          Object.entries(current.classes).map(([classId, classDraft]) => [
            classId,
            {
              ...classDraft,
              studentFeeCodes: Object.fromEntries(
                Object.entries(classDraft.studentFeeCodes).map(([rowId, codes]) => [
                  rowId,
                  codes.filter((item) => item !== code),
                ]),
              ),
            },
          ]),
        ),
      };
    });
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
          <p>正在載入學生與課程...</p>
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
            <span>學生與課程</span>
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
          <h1>無法載入學生與課程</h1>
          <p>{loadError}</p>
        </section>
      </main>
    );
  }

  if (!canViewStudents) {
    return (
      <main className="dashboard-page">
        <header className="dashboard-topbar no-print">
          <Link className="dashboard-brand" to="/dashboard">
            <span className="brand-mark dark" aria-hidden="true">
              AP
            </span>
            <span>學生與課程</span>
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
          <h1>尚不能匯入學生資料</h1>
          <p>請負責人開通學生與課程權限後，再使用學費袋匯入功能。</p>
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
          <span>學生與課程</span>
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

      <section className="import-shell" aria-labelledby="students-title">
        <div className="import-hero">
          <div>
            <p className="dashboard-kicker">學生收費工作台</p>
            <h1 id="students-title">匯入資料後，就在系統裡處理收費</h1>
            <p>
              Excel 只用來建立第一份學生、班級、課程與雜項資料。匯入完成後，
              日常調整、列印通知單與後續收款都會在這個工作台進行。
            </p>
          </div>
          <span>{workspace.organization.name}</span>
        </div>

        <div className="import-stepper platform-stepper" aria-label="工作流程">
          <UploadStep
            active={!result || importStatus === "parsing"}
            complete={Boolean(result)}
            title="1. 資料匯入"
          >
            從學費袋建立學生、課程、日期與雜項。
          </UploadStep>
          <UploadStep active={Boolean(result)} title="2. 收費工作台">
            依班級調整日期、雜項與每位學生應繳金額。
          </UploadStep>
          <UploadStep active={Boolean(result)} title="3. 通知單與收款">
            列印通知單，之後接上付款狀態與收據。
          </UploadStep>
        </div>

        <section className={`data-import-panel ${result ? "ready" : ""}`}>
          <div className="data-import-copy">
            <p className="dashboard-kicker">資料匯入</p>
            <h2>
              {result
                ? savedWorkspace && !hasUnsavedChanges
                  ? "已從系統載入資料"
                  : "資料已載入工作台"
                : "匯入學費袋 Excel"}
            </h2>
            <p>
              {result
                ? savedWorkspace && !hasUnsavedChanges
                  ? "重新整理後仍會回到這份工作台。需要換資料時，可以重新匯入 Excel。"
                  : "這份資料還在目前畫面中，按下「儲存到系統」後，重新整理也不會消失。"
                : "先把 Excel 轉成系統資料，接著就能用班級工作台產生通知單。"}
            </p>
          </div>

          <section
            className={`upload-dropzone ${dragging ? "dragging" : ""} ${
              result ? "compact" : ""
            }`}
            onDragEnter={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={() => setDragging(false)}
            onDrop={handleDrop}
          >
            <input
              accept=".xlsx"
              aria-label="選擇學費袋 Excel"
              className="sr-only"
              onChange={(event) => handleFile(event.target.files?.[0])}
              ref={inputRef}
              type="file"
            />
            {result ? (
              <div className="upload-source-summary">
                <strong>{result.fileName}</strong>
                <span>
                  {formatFileSize(result.fileSize)} /{" "}
                  {result.summary.classSheetCount} 個班級 /{" "}
                  {result.summary.studentCount} 位學生
                </span>
              </div>
            ) : (
              <>
                <div className="upload-icon" aria-hidden="true">
                  ↑
                </div>
                <h2>拖曳學費袋 Excel 到這裡</h2>
                <p>支援 .xlsx，匯入後進入收費工作台。</p>
              </>
            )}
            <button
              className="upload-picker-button"
              onClick={() => inputRef.current?.click()}
              type="button"
            >
              {result ? "更換 Excel" : "選擇檔案"}
            </button>
            {importStatus === "parsing" ? (
              <p className="upload-status">正在整理資料...</p>
            ) : null}
            {savedLoadStatus === "loading" ? (
              <p className="upload-status">正在載入已儲存的收費資料...</p>
            ) : null}
            {savedLoadStatus === "error" && !result ? (
              <p className="auth-error">
                無法載入已儲存資料。仍可重新匯入 Excel。
              </p>
            ) : null}
            {importError ? <p className="auth-error">{importError}</p> : null}
          </section>
        </section>

        {result && selectedClassSheet && selectedClassDraft ? (
          <section className="invoice-builder" aria-labelledby="invoice-title">
            <div className="result-heading workspace-heading">
              <div>
                <p className="dashboard-kicker">收費工作台</p>
                <h2 id="invoice-title">本期繳費通知單</h2>
                <p className="workspace-source">來源：{result.fileName}</p>
              </div>
              <div className="workspace-summary-grid" aria-label="工作台摘要">
                <article>
                  <span>班級</span>
                  <strong>{result.summary.classSheetCount}</strong>
                </article>
                <article>
                  <span>學生</span>
                  <strong>{result.summary.studentCount}</strong>
                </article>
                <article>
                  <span>本班通知單</span>
                  <strong>{workspaceTotals.invoiceCount}</strong>
                </article>
                <article>
                  <span>本班應收</span>
                  <strong>{formatCurrency(workspaceTotals.activeClassTotal)}</strong>
                </article>
                <article>
                  <span>雜項</span>
                  <strong>{workspaceTotals.feeOptionCount}</strong>
                </article>
              </div>
              <div className="workspace-action-row">
                <button
                  className="save-workspace-button"
                  disabled={saveStatus === "saving" || !hasUnsavedChanges}
                  onClick={handleSaveWorkspace}
                  type="button"
                >
                  {saveStatus === "saving"
                    ? "儲存中..."
                    : hasUnsavedChanges
                      ? "儲存到系統"
                      : "已儲存"}
                </button>
                <button
                  className="confirm-import-button"
                  onClick={() => window.print()}
                  type="button"
                >
                  列印通知單
                </button>
                <p
                  className={`workspace-save-note ${
                    hasUnsavedChanges ? "unsaved" : ""
                  }`}
                >
                  {saveError ||
                    (hasUnsavedChanges
                      ? "尚未儲存，重新整理後會回到上次儲存資料。"
                      : "已儲存，重新整理後不需要再匯入 Excel。")}
                </p>
              </div>
            </div>

            <div className="class-tab-row" aria-label="班級">
              {result.classSheets.map((sheet) => (
                <button
                  aria-pressed={selectedClassSheet.id === sheet.id}
                  className={selectedClassSheet.id === sheet.id ? "active" : ""}
                  key={sheet.id}
                  onClick={() => {
                    setActiveClassId(sheet.id);
                    setSelectedInvoiceRowId(sheet.studentRows[0]?.id || "");
                  }}
                  type="button"
                >
                  {sheet.name}
                  <span>{sheet.studentCount}</span>
                </button>
              ))}
            </div>

            <section className="global-date-panel">
              <div className="panel-heading">
                <p className="dashboard-kicker">全班日期</p>
                <h2>{selectedClassSheet.name}</h2>
                <p>從月曆新增全班日期後，仍可在每位學生的格子中微調。</p>
              </div>
              <div className="course-date-grid">
                {selectedClassSheet.courseBlocks.map((course) => (
                  <article key={course.id}>
                    <h3>{course.label}</h3>
                    <div className="date-input-row">
                      <input
                        aria-label={`${course.label} 新增日期`}
                        onChange={(event) =>
                          setDateDrafts((current) => ({
                            ...current,
                            [course.id]: event.target.value,
                          }))
                        }
                        type="date"
                        value={dateDrafts[course.id] || ""}
                      />
                      <button onClick={() => addGlobalDate(course.id)} type="button">
                        加入
                      </button>
                    </div>
                    <div className="date-chip-list">
                      {(selectedClassDraft.globalDates[course.id] || []).map(
                        (date) => (
                          <button
                            key={date}
                            onClick={() => removeGlobalDate(course.id, date)}
                            type="button"
                          >
                            {formatDateShort(date)} ×
                          </button>
                        ),
                      )}
                    </div>
                  </article>
                ))}
              </div>
            </section>

            <div className="invoice-workspace-grid">
              <section className="invoice-sheet-panel">
                <div className="panel-heading">
                  <p className="dashboard-kicker">班級表格</p>
                  <h2>收費資料</h2>
                  <p>
                    順序對齊 Excel：編號、姓名、科目、課程日期、雜項、合計。
                  </p>
                </div>
                <div className="invoice-sheet-wrap">
                  <table className="invoice-sheet-table">
                    <thead>
                      <tr>
                        <th>編號</th>
                        <th>姓名</th>
                        <th>科目</th>
                        {selectedClassSheet.courseBlocks.map((course) => (
                          <th key={course.id}>{course.label}</th>
                        ))}
                        <th>雜項</th>
                        <th>合計</th>
                        <th>列印</th>
                      </tr>
                    </thead>
                    <tbody>
                      {invoiceRows.map((row) => {
                        const selectedCodes =
                          selectedClassDraft.studentFeeCodes[row.id] || [];
                        const customFees =
                          selectedClassDraft.studentCustomFees[row.id] || [];

                        return (
                          <tr
                            className={
                              selectedInvoiceRow?.id === row.id ? "active" : ""
                            }
                            key={row.id}
                          >
                            <td>{row.studentNumber}</td>
                            <td>{row.studentName}</td>
                            <td>
                              <div className="subject-pill-row">
                                {row.subjects.map((subject) => (
                                  <span key={subject}>{subject}</span>
                                ))}
                              </div>
                            </td>
                            {selectedClassSheet.courseBlocks.map((course) => {
                              const rowDates =
                                selectedClassDraft.studentDates[row.id]?.[
                                  course.id
                                ] || [];
                              const visibleDates = sortDates([
                                ...(selectedClassDraft.globalDates[course.id] ||
                                  []),
                                ...rowDates,
                              ]);
                              const courseLine = row.invoice.courseLines.find(
                                (line) => line.id === course.id,
                              );

                              return (
                                <td key={course.id}>
                                  <div className="date-toggle-grid">
                                    {visibleDates.map((date) => (
                                      <button
                                        className={
                                          rowDates.includes(date) ? "active" : ""
                                        }
                                        key={date}
                                        onClick={() =>
                                          toggleStudentDate(
                                            row.id,
                                            course.id,
                                            date,
                                          )
                                        }
                                        type="button"
                                      >
                                        {formatDateShort(date)}
                                      </button>
                                    ))}
                                  </div>
                                  <p className="cell-total">
                                    {courseLine.sessionCount} 堂 /{" "}
                                    {formatCurrency(courseLine.amount)}
                                  </p>
                                </td>
                              );
                            })}
                            <td>
                              <select
                                aria-label={`${row.studentName} 加入雜項`}
                                onChange={(event) => {
                                  addStudentFee(row.id, event.target.value);
                                  event.target.value = "";
                                }}
                              >
                                <option value="">加入雜項</option>
                                {feeOptions.map((option) => (
                                  <option key={option.code} value={option.code}>
                                    {option.code} {option.name}
                                  </option>
                                ))}
                              </select>
                              <div className="fee-chip-list">
                                {selectedCodes.map((code) => {
                                  const option = feeOptionsByCode.get(code);

                                  if (!option) {
                                    return null;
                                  }

                                  return (
                                    <button
                                      key={code}
                                      onClick={() => removeStudentFee(row.id, code)}
                                      type="button"
                                    >
                                      {option.name} {formatCurrency(option.amount)} ×
                                    </button>
                                  );
                                })}
                                {customFees.map((fee) => (
                                  <span key={fee.id}>
                                    {fee.name} {formatCurrency(fee.amount)}
                                  </span>
                                ))}
                              </div>
                            </td>
                            <td>
                              <strong>{formatCurrency(row.invoice.total)}</strong>
                            </td>
                            <td>
                              <button
                                className="table-action-button"
                                onClick={() => setSelectedInvoiceRowId(row.id)}
                                type="button"
                              >
                                預覽
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </section>

              <section className="invoice-preview-panel">
                <div className="panel-heading">
                  <p className="dashboard-kicker">列印預覽</p>
                  <h2>{selectedInvoiceRow?.studentName || "未選擇學生"}</h2>
                  <p>點選表格右側「預覽」即可切換學生。</p>
                </div>
                {selectedInvoiceRow ? (
                  <div className="invoice-print-area">
                    <header>
                      <p>{workspace.organization.name}</p>
                      <h2>收費通知單</h2>
                    </header>
                    <div className="invoice-meta-grid">
                      <span>班級：{selectedClassSheet.name}</span>
                      <span>編號：{selectedInvoiceRow.studentNumber}</span>
                      <span>學生：{selectedInvoiceRow.studentName}</span>
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
                        {selectedInvoiceRow.invoice.courseLines.map((line) => (
                          <tr key={line.id}>
                            <td>{line.label}</td>
                            <td>
                              {line.sessionCount} 堂：
                              {line.dates.map(formatDateShort).join("、")}
                            </td>
                            <td>{formatCurrency(line.amount)}</td>
                          </tr>
                        ))}
                        {selectedInvoiceRow.invoice.feeLines.map((line) => (
                          <tr key={line.id}>
                            <td>{line.label}</td>
                            <td>{line.details || `雜項代碼 ${line.code}`}</td>
                            <td>{formatCurrency(line.amount)}</td>
                          </tr>
                        ))}
                        {selectedInvoiceRow.invoice.customFeeLines.map((line) => (
                          <tr key={line.id}>
                            <td>{line.name}</td>
                            <td>自訂雜項</td>
                            <td>{formatCurrency(line.amount)}</td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr>
                          <td colSpan="2">本期應繳合計</td>
                          <td>{formatCurrency(selectedInvoiceRow.invoice.total)}</td>
                        </tr>
                      </tfoot>
                    </table>
                    <p className="invoice-receipt-note">
                      請攜帶此通知單繳費。已於 ____ 月 ____ 日繳清，謝謝！
                    </p>
                  </div>
                ) : null}
              </section>
            </div>

            <section className="fee-options-manager">
              <div className="panel-heading">
                <p className="dashboard-kicker">雜項表管理</p>
                <h2>可套用選項</h2>
                <p>這裡管理本次匯入可選的雜項代碼、名稱、金額與備註。</p>
              </div>
              <form className="fee-option-form" onSubmit={handleFeeSubmit}>
                <label>
                  代碼
                  <input
                    name="code"
                    onChange={handleFeeFormChange}
                    value={feeForm.code}
                  />
                </label>
                <label>
                  名稱
                  <input
                    name="name"
                    onChange={handleFeeFormChange}
                    value={feeForm.name}
                  />
                </label>
                <label>
                  金額
                  <input
                    name="amount"
                    onChange={handleFeeFormChange}
                    type="number"
                    value={feeForm.amount}
                  />
                </label>
                <label>
                  備註 / 條件
                  <input
                    name="details"
                    onChange={handleFeeFormChange}
                    value={feeForm.details}
                  />
                </label>
                <button type="submit">
                  {editingFeeCode ? "更新雜項" : "新增雜項"}
                </button>
                {editingFeeCode ? (
                  <button onClick={resetFeeForm} type="button">
                    取消
                  </button>
                ) : null}
              </form>
              <div className="fee-options-table-wrap">
                <table className="fee-options-table">
                  <thead>
                    <tr>
                      <th>代碼</th>
                      <th>名稱</th>
                      <th>金額</th>
                      <th>備註 / 條件</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {feeOptions.map((option) => (
                      <tr key={option.code}>
                        <td>{option.code}</td>
                        <td>{option.name}</td>
                        <td>{formatCurrency(option.amount)}</td>
                        <td>{getFeeDetailsText(option) || "無"}</td>
                        <td>
                          <button
                            onClick={() => editFeeOption(option)}
                            type="button"
                          >
                            編輯
                          </button>
                          <button
                            onClick={() => deleteFeeOption(option.code)}
                            type="button"
                          >
                            移除
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </section>
        ) : null}
      </section>
    </main>
  );
}

export default StudentsCoursesPage;

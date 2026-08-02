import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { onAuthStateChanged, signOut } from "firebase/auth";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { auth } from "../lib/firebase";
import {
  saveBranchFeeOptions,
  saveCurrentBillingWorkspace,
  subscribeBranchFeeOptions,
  subscribeCurrentBillingWorkspace,
} from "../lib/billingWorkspaceData";
import {
  createOrganizationBranch,
  isOrganizationSetupRequiredError,
  loadOrganizationWorkspace,
} from "../lib/orgData";
import {
  createStudentAccountId,
  getInvoiceStatusLabel,
  saveStudentInvoiceNotice,
  subscribeStudentInvoices,
  syncStudentAccountsFromClassSheets,
} from "../lib/studentInvoiceData";
import { organizeTuitionBagFile } from "../lib/tuitionBagImport";

const EMPTY_FEE_FORM = {
  code: "",
  name: "",
  amount: "",
  details: "",
};
const EMPTY_STUDENT_FORM = {
  studentNumber: "",
  studentName: "",
};
const SUBJECT_OPTIONS = [
  { value: "數", label: "數學" },
  { value: "英", label: "英文" },
  { value: "理", label: "理化" },
  { value: "自", label: "自訂" },
];
const ATTENDANCE_GROUP_OPTIONS = [
  { value: "A", label: "A班" },
  { value: "B", label: "B班" },
];
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
const STUDENTS_COURSES_CLIENT_ID = `students-courses-${Date.now()}-${Math.random()
  .toString(36)
  .slice(2, 10)}`;

function getWorkspaceErrorMessage(error) {
  if (error.code === "permission-denied") {
    return "Firestore 拒絕讀取工作區。請先發布 Firestore rules，並確認你的權限。";
  }

  return "帳號已登入，但目前無法載入學生與課程工作區。";
}

function formatCurrency(amount) {
  return `${amount.toLocaleString()} 元`;
}

function formatDateShort(date) {
  const [, month, day] = date.split("-");
  return `${Number(month)}/${Number(day)}`;
}

function formatDateTime(value) {
  if (!value) {
    return "未記錄";
  }

  const date = new Date(value);

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

function sortDates(dates) {
  return [...new Set(dates)].sort((a, b) => a.localeCompare(b));
}

function getCourseChoiceLabel(course) {
  return (
    getSubjectAlias(course.subjectCode) ||
    course.label ||
    course.subjectName ||
    course.subjectCode ||
    "課程"
  );
}

function getSubjectAlias(code) {
  if (code === "數") {
    return "數學";
  }

  if (code === "英") {
    return "英文";
  }

  if (code === "理") {
    return "理化";
  }

  return "";
}

function createStudentCourseSelections(sheet) {
  return Object.fromEntries(
    sheet.studentRows.map((row) => [
      row.id,
      Object.fromEntries(
        sheet.courseBlocks.map((course) => [
          course.id,
          Boolean((row.courseDates[course.id] || []).length),
        ]),
      ),
    ]),
  );
}

function createCourseAttendanceEnabledMap(sheet, enabled = false) {
  return Object.fromEntries(
    sheet.courseBlocks.map((course) => [course.id, enabled]),
  );
}

function createStudentAttendanceGroupsByCourse(sheet, defaultGroup = "A") {
  return Object.fromEntries(
    sheet.courseBlocks.map((course) => [
      course.id,
      Object.fromEntries(sheet.studentRows.map((row) => [row.id, defaultGroup])),
    ]),
  );
}

function isCourseAttendanceGroupsEnabled(classDraft, courseId) {
  return Boolean(classDraft?.attendanceGroupEnabledByCourse?.[courseId]);
}

function getStudentCourseAttendanceGroup(classDraft, courseId, rowId) {
  const courseGroup = classDraft?.studentAttendanceGroupsByCourse?.[courseId]?.[
    rowId
  ];

  if (courseGroup === "B") {
    return "B";
  }

  return "A";
}

function getAttendanceGroupLabel(group) {
  return ATTENDANCE_GROUP_OPTIONS.find((option) => option.value === group)?.label ||
    "A班";
}

function getAttendanceDateColumns(classDraft, courseId) {
  const dates = sortDates(classDraft?.globalDates?.[courseId] || []);
  const minimumColumnCount = 8;
  const blankCount = Math.max(0, minimumColumnCount - dates.length);

  return [
    ...dates.map((date) => ({ id: date, label: formatDateShort(date) })),
    ...Array.from({ length: blankCount }, (_, index) => ({
      id: `blank-${index}`,
      label: "/",
    })),
  ];
}

function isStudentCourseSelected(classDraft, rowId, course) {
  const selections = classDraft?.studentCourseSelections?.[rowId];

  if (
    selections &&
    Object.prototype.hasOwnProperty.call(selections, course.id)
  ) {
    return Boolean(selections[course.id]);
  }

  return Boolean((classDraft?.studentDates?.[rowId]?.[course.id] || []).length);
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
    if (!isStudentCourseSelected(classDraft, row.id, course)) {
      return;
    }

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
          studentCourseSelections: createStudentCourseSelections(sheet),
          attendanceGroupEnabledByCourse: createCourseAttendanceEnabledMap(sheet),
          studentAttendanceGroupsByCourse:
            createStudentAttendanceGroupsByCourse(sheet),
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

function createEmptyInvoiceState() {
  return {
    classes: {},
  };
}

function createResultShell({
  classSheets = [],
  fileName = "系統手動建立",
  feeItems = [],
} = {}) {
  return {
    fileName,
    fileSize: 0,
    detectedAt: new Date().toISOString(),
    summary: {
      totalSheets: classSheets.length,
      classSheetCount: classSheets.length,
      printSheetCount: 0,
      ignoredSheetCount: 0,
      studentCount: classSheets.reduce(
        (total, sheet) => total + sheet.studentRows.length,
        0,
      ),
      enrollmentCount: 0,
      sessionCount: 0,
      feeItemCount: feeItems.length,
      feeDraftCount: 0,
      receivableDraftCount: 0,
    },
    classSheets,
    printSheets: [],
    ignoredSheets: [],
    students: [],
    enrollments: [],
    sessions: [],
    feeItems,
    feeDrafts: [],
    receivableDrafts: [],
  };
}

function createClassCourseFormRow() {
  return {
    id: `course-form-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    courseName: "",
    subjectCode: "數",
  };
}

function createBlankClassForm() {
  return {
    className: "",
    courseRows: [createClassCourseFormRow()],
  };
}

function createStudentRowId(classId) {
  if (globalThis.crypto?.randomUUID) {
    return `${classId}-row-${globalThis.crypto.randomUUID()}`;
  }

  return `${classId}-row-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

function withoutRecordKey(record = {}, key) {
  const nextRecord = { ...record };

  delete nextRecord[key];

  return nextRecord;
}

function withoutNestedRecordKey(record = {}, key) {
  return Object.fromEntries(
    Object.entries(record || {}).map(([recordKey, nestedRecord]) => [
      recordKey,
      withoutRecordKey(nestedRecord, key),
    ]),
  );
}

function getDefaultCourseLabel(subjectCode) {
  return getSubjectAlias(subjectCode) || "課程";
}

function createManualClassSheet({ className, courseRows }) {
  const createdAt = Date.now();
  const id = `manual-${className}-${createdAt}`;
  const normalizedRows = (courseRows || [])
    .map((course) => ({
      courseName: course.courseName.trim(),
      subjectCode: course.subjectCode || "自",
    }))
    .filter((course) => course.courseName || course.subjectCode);
  const rows = normalizedRows.length
    ? normalizedRows
    : [{ courseName: "", subjectCode: "數" }];
  const courseBlocks = rows.map((course, index) => {
    const courseLabel =
      course.courseName || getDefaultCourseLabel(course.subjectCode);

    return {
      id: `${course.subjectCode}-${createdAt}-${index}`,
      start: 4 + index * 8,
      end: 11 + index * 8,
      label: courseLabel,
      subjectCode: course.subjectCode,
      subjectName: getDefaultCourseLabel(course.subjectCode) || courseLabel,
      globalDates: [],
      dateUsage: [],
    };
  });

  return {
    id,
    name: className,
    courseLabels: courseBlocks.map((course) => course.label),
    courseBlocks,
    studentRows: [],
    studentCount: 0,
    enrollmentCount: 0,
    sessionCount: 0,
    feeDrafts: [],
    receivableDrafts: [],
  };
}

function createManualClassDraft(sheet) {
  return {
    globalDates: Object.fromEntries(
      sheet.courseBlocks.map((course) => [course.id, course.globalDates]),
    ),
    attendanceGroupEnabledByCourse: createCourseAttendanceEnabledMap(sheet),
    studentAttendanceGroupsByCourse:
      createStudentAttendanceGroupsByCourse(sheet),
    studentDates: {},
    studentCourseSelections: {},
    studentFeeCodes: {},
    studentCustomFees: {},
  };
}

function refreshResultSummary(result) {
  const classSheets = result.classSheets || [];

  return {
    ...result,
    summary: {
      ...result.summary,
      totalSheets: classSheets.length,
      classSheetCount: classSheets.length,
      studentCount: classSheets.reduce(
        (total, sheet) => total + sheet.studentRows.length,
        0,
      ),
      sessionCount: classSheets.reduce(
        (total, sheet) =>
          total +
          sheet.studentRows.reduce(
            (rowTotal, row) =>
              rowTotal +
              Object.values(row.courseDates).reduce(
                (dateTotal, dates) => dateTotal + dates.length,
                0,
              ),
            0,
          ),
        0,
      ),
    },
  };
}

function calculateInvoice(row, sheet, classDraft, feeOptionsByCode) {
  const courseLines = sheet.courseBlocks
    .filter((course) => isStudentCourseSelected(classDraft, row.id, course))
    .map((course) => {
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
  const autoSaveInFlightRef = useRef(false);
  const autoSaveQueuedRef = useRef(false);
  const autoSaveRetryTimerRef = useRef(null);
  const autoSaveTimerRef = useRef(null);
  const branchFeeOptionsLoadedRef = useRef(false);
  const dirtyVersionRef = useRef(0);
  const latestAutoSaveDataRef = useRef(null);
  const runAutoSaveRef = useRef(null);
  const savedVersionRef = useRef(0);
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
  const [activeBranchId, setActiveBranchId] = useState("");
  const [branchModalOpen, setBranchModalOpen] = useState(false);
  const [branchForm, setBranchForm] = useState({ name: "" });
  const [branchSaveStatus, setBranchSaveStatus] = useState("idle");
  const [branchError, setBranchError] = useState("");
  const [activeClassId, setActiveClassId] = useState("");
  const [invoiceState, setInvoiceState] = useState(null);
  const [feeOptions, setFeeOptions] = useState(
    withAutomaticFeeOptions([]),
  );
  const [feeForm, setFeeForm] = useState(EMPTY_FEE_FORM);
  const [editingFeeCode, setEditingFeeCode] = useState("");
  const [classForm, setClassForm] = useState(() => createBlankClassForm());
  const [studentForm, setStudentForm] = useState(EMPTY_STUDENT_FORM);
  const [showCompactImport, setShowCompactImport] = useState(false);
  const [dateDrafts, setDateDrafts] = useState({});
  const [selectedInvoiceRowId, setSelectedInvoiceRowId] = useState("");
  const [invoicePreviewOpen, setInvoicePreviewOpen] = useState(false);
  const [attendancePreviewTarget, setAttendancePreviewTarget] = useState(null);
  const [invoiceNoticeError, setInvoiceNoticeError] = useState("");
  const [invoiceNoticeStatus, setInvoiceNoticeStatus] = useState("idle");
  const [lastGeneratedInvoiceId, setLastGeneratedInvoiceId] = useState("");
  const [studentInvoiceHistory, setStudentInvoiceHistory] = useState([]);
  const [studentInvoiceHistoryStatus, setStudentInvoiceHistoryStatus] =
    useState("idle");
  const [classModalOpen, setClassModalOpen] = useState(false);
  const [studentDeleteTarget, setStudentDeleteTarget] = useState(null);
  const [studentModalOpen, setStudentModalOpen] = useState(false);
  const [dateModalCourseId, setDateModalCourseId] = useState("");
  const [feeModalOpen, setFeeModalOpen] = useState(false);
  const [dismissedDoubleCourseRows, setDismissedDoubleCourseRows] = useState([]);
  const [savedLoadBranchId, setSavedLoadBranchId] = useState("");
  const [savedLoadStatus, setSavedLoadStatus] = useState("idle");
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
        console.error("Unable to load students workspace:", error);

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

  const canViewStudents = workspace?.member?.permissions?.canViewStudents;
  const canManageBranches =
    workspace?.member?.roleLevel === 1 ||
    workspace?.member?.permissions?.canManageOrganization;
  const branchOptions = useMemo(
    () => workspace?.visibleBranches || [],
    [workspace?.visibleBranches],
  );
  const selectedBranch = useMemo(
    () =>
      branchOptions.find((branch) => branch.id === activeBranchId) ||
      branchOptions[0] ||
      null,
    [activeBranchId, branchOptions],
  );
  const hasSelectedBranch = Boolean(selectedBranch?.id);
  const savedWorkspaceReadyForBranch =
    hasSelectedBranch &&
    savedLoadStatus === "ready" &&
    savedLoadBranchId === activeBranchId;
  const savedWorkspaceErrorForBranch =
    hasSelectedBranch &&
    savedLoadStatus === "error" &&
    savedLoadBranchId === activeBranchId;
  const savedWorkspaceLoading =
    hasSelectedBranch &&
    !savedWorkspaceReadyForBranch &&
    !savedWorkspaceErrorForBranch;
  const hasLoadedResult =
    hasSelectedBranch && !savedWorkspaceLoading && Boolean(result);
  const pageTitle = savedWorkspaceLoading
    ? "正在載入學生收費資料"
    : hasLoadedResult
      ? "本期學生收費資料"
      : "建立第一份學生收費資料";
  const pageDescription = savedWorkspaceLoading
    ? "正在從 Firebase 讀取目前分校的班級、學生、雜項與通知單資料。"
    : hasLoadedResult
      ? "資料已在系統中，日常工作以班級、學生、雜項與通知單為主。修改後會自動儲存。"
      : "第一次可以匯入學費袋 Excel，也可以直接建立班級、學生與雜項表。建立後系統會自動儲存。";
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
  const courseAttendanceEnabledMap = Object.fromEntries(
    (selectedClassSheet?.courseBlocks || []).map((course) => [
      course.id,
      isCourseAttendanceGroupsEnabled(selectedClassDraft, course.id),
    ]),
  );
  const hasCourseAttendanceGroupsEnabled = Object.values(
    courseAttendanceEnabledMap,
  ).some(Boolean);
  const dateModalCourse =
    selectedClassSheet?.courseBlocks.find(
      (course) => course.id === dateModalCourseId,
    ) || null;
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
  const selectedStudentAccountId = selectedInvoiceRow?.studentId || "";
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
    latestAutoSaveDataRef.current = {
      activeBranchId,
      activeClassId,
      dismissedDoubleCourseRows,
      feeOptions,
      invoiceState,
      orgId: workspace?.activeOrgId || "",
      result,
      selectedBranch,
      savedByUid: currentUser?.uid || "",
      selectedInvoiceRowId: selectedInvoiceRow?.id || selectedInvoiceRowId,
    };
  }, [
    activeBranchId,
    activeClassId,
    currentUser?.uid,
    dismissedDoubleCourseRows,
    feeOptions,
    invoiceState,
    result,
    selectedBranch,
    selectedInvoiceRow?.id,
    selectedInvoiceRowId,
    workspace?.activeOrgId,
  ]);

  useEffect(() => {
    if (
      authStatus !== "ready" ||
      !canViewStudents ||
      !workspace?.activeOrgId ||
      !activeBranchId
    ) {
      return undefined;
    }

    let active = true;
    const resetWorkspace = () => {
      setResult(null);
      setInvoiceState(null);
      setFeeOptions(withAutomaticFeeOptions([]));
      setActiveClassId("");
      setSelectedInvoiceRowId("");
      setDismissedDoubleCourseRows([]);
      setShowCompactImport(false);
      setDateModalCourseId("");
      setAttendancePreviewTarget(null);
      setStudentDeleteTarget(null);
      setStudentModalOpen(false);
      setFeeModalOpen(false);
      setSaveStatus("idle");
      setSaveError("");
      setHasUnsavedChanges(false);
      dirtyVersionRef.current = 0;
      savedVersionRef.current = 0;
      autoSaveQueuedRef.current = false;
      setImportStatus("idle");
    };
    const applySavedWorkspace = (saved) => {
      const firstClass = saved.result.classSheets[0];
      const activeClass =
        saved.result.classSheets.find(
          (sheet) => sheet.id === saved.activeClassId,
        ) || firstClass;
      const firstRow = activeClass?.studentRows[0];
      const syncedVersion =
        saved.savedByClientId === STUDENTS_COURSES_CLIENT_ID
          ? Number(saved.clientSaveVersion) || dirtyVersionRef.current
          : dirtyVersionRef.current;

      setResult(saved.result);
      setInvoiceState(saved.invoiceState);
      if (!branchFeeOptionsLoadedRef.current) {
        setFeeOptions(withAutomaticFeeOptions(saved.feeOptions));
      }
      setActiveClassId(activeClass?.id || "");
      setSelectedInvoiceRowId(saved.selectedInvoiceRowId || firstRow?.id || "");
      setDismissedDoubleCourseRows(saved.dismissedDoubleCourseRows);
      setSaveStatus("saved");
      setHasUnsavedChanges(false);
      dirtyVersionRef.current = syncedVersion;
      savedVersionRef.current = syncedVersion;
      setImportStatus("ready");
    };

    let unsubscribe = () => {};

    Promise.resolve().then(() => {
      if (!active) {
        return;
      }

      setSavedLoadStatus("loading");
      setSavedLoadBranchId(activeBranchId);
      resetWorkspace();

      unsubscribe = subscribeCurrentBillingWorkspace({
        branchId: activeBranchId,
        fallbackToOrganizationWorkspace: activeBranchId === branchOptions[0]?.id,
        onChange: (saved) => {
          if (!active) {
            return;
          }

          setSavedLoadBranchId(activeBranchId);
          setSavedLoadStatus("ready");

          if (!saved) {
            resetWorkspace();
            return;
          }

          if (saved.metadata?.hasPendingWrites) {
            return;
          }

          const isOwnSnapshot =
            saved.savedByClientId === STUDENTS_COURSES_CLIENT_ID;
          const localPending =
            autoSaveInFlightRef.current ||
            dirtyVersionRef.current !== savedVersionRef.current;
          const olderOwnSnapshot =
            isOwnSnapshot &&
            Number(saved.clientSaveVersion || 0) < dirtyVersionRef.current;

          if (olderOwnSnapshot || (!isOwnSnapshot && localPending)) {
            return;
          }

          applySavedWorkspace(saved);
        },
        onError: (error) => {
          console.error("Unable to listen to saved billing workspace:", error);

          if (active) {
            setSavedLoadBranchId(activeBranchId);
            setSavedLoadStatus("error");
          }
        },
        orgId: workspace.activeOrgId,
      });
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [
    activeBranchId,
    authStatus,
    branchOptions,
    canViewStudents,
    workspace?.activeOrgId,
  ]);

  useEffect(() => {
    if (
      authStatus !== "ready" ||
      !canViewStudents ||
      !workspace?.activeOrgId ||
      !activeBranchId
    ) {
      return undefined;
    }

    branchFeeOptionsLoadedRef.current = false;

    return subscribeBranchFeeOptions({
      branchId: activeBranchId,
      onChange: (saved) => {
        if (saved.metadata?.hasPendingWrites) {
          return;
        }

        branchFeeOptionsLoadedRef.current = saved.exists;

        if (saved.exists) {
          setFeeOptions(withAutomaticFeeOptions(saved.feeOptions));
        }
      },
      onError: (error) => {
        console.error("Unable to listen to branch fee options:", error);
        setSaveError("無法載入分校雜項表。請確認 Firestore 權限。");
        setSaveStatus("error");
      },
      orgId: workspace.activeOrgId,
    });
  }, [
    activeBranchId,
    authStatus,
    canViewStudents,
    workspace?.activeOrgId,
  ]);

  useEffect(() => {
    let active = true;
    let unsubscribe = () => {};

    Promise.resolve().then(() => {
      if (!active) {
        return;
      }

      if (
        !invoicePreviewOpen ||
        !workspace?.activeOrgId ||
        !selectedStudentAccountId
      ) {
        setStudentInvoiceHistory([]);
        setStudentInvoiceHistoryStatus("idle");
        return;
      }

      setStudentInvoiceHistoryStatus("loading");
      unsubscribe = subscribeStudentInvoices({
        onChange: (records) => {
          if (!active) {
            return;
          }

          setStudentInvoiceHistory(records);
          setStudentInvoiceHistoryStatus("ready");
        },
        onError: (error) => {
          console.error("Unable to listen to student invoices:", error);

          if (active) {
            setStudentInvoiceHistory([]);
            setStudentInvoiceHistoryStatus("error");
          }
        },
        orgId: workspace.activeOrgId,
        studentId: selectedStudentAccountId,
      });
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [invoicePreviewOpen, selectedStudentAccountId, workspace?.activeOrgId]);

  useEffect(() => {
    if (
      !invoicePreviewOpen &&
      !attendancePreviewTarget &&
      !classModalOpen &&
      !branchModalOpen &&
      !studentDeleteTarget &&
      !studentModalOpen &&
      !dateModalCourseId &&
      !feeModalOpen
    ) {
      return undefined;
    }

    const originalOverflow = document.body.style.overflow;
    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        if (studentDeleteTarget) {
          setStudentDeleteTarget(null);
          return;
        }

        if (attendancePreviewTarget) {
          setAttendancePreviewTarget(null);
          return;
        }

        if (dateModalCourseId) {
          setDateModalCourseId("");
          return;
        }

        if (studentModalOpen) {
          setStudentModalOpen(false);
          return;
        }

        if (feeModalOpen) {
          setFeeModalOpen(false);
          return;
        }

        if (branchModalOpen) {
          setBranchModalOpen(false);
          return;
        }

        if (classModalOpen) {
          setClassModalOpen(false);
          return;
        }

        setInvoicePreviewOpen(false);
      }
    };

    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      document.body.style.overflow = originalOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [
    classModalOpen,
    attendancePreviewTarget,
    branchModalOpen,
    dateModalCourseId,
    feeModalOpen,
    invoicePreviewOpen,
    studentDeleteTarget,
    studentModalOpen,
  ]);

  const markWorkspaceDirty = () => {
    dirtyVersionRef.current += 1;
    setHasUnsavedChanges(true);
    setSaveStatus("idle");
    setSaveError("");
  };

  const persistBranchFeeOptions = async (nextFeeOptions) => {
    if (!activeBranchId || !workspace?.activeOrgId) {
      return;
    }

    setSaveStatus("saving");
    setSaveError("");

    try {
      await saveBranchFeeOptions({
        branchId: activeBranchId,
        feeOptions: nextFeeOptions,
        orgId: workspace.activeOrgId,
        savedByClientId: STUDENTS_COURSES_CLIENT_ID,
        savedByUid: currentUser?.uid || "",
      });
      setSaveStatus("saved");
    } catch (error) {
      console.error("Unable to save branch fee options:", error);
      setSaveError("雜項表自動儲存失敗。請確認網路與 Firestore 權限。");
      setSaveStatus("error");
    }
  };

  const runAutoSave = useCallback(async () => {
    const snapshot = latestAutoSaveDataRef.current;

    if (
      !snapshot?.result ||
      !snapshot.invoiceState ||
      !snapshot.activeBranchId ||
      !snapshot.orgId
    ) {
      return;
    }

    if (autoSaveInFlightRef.current) {
      autoSaveQueuedRef.current = true;
      return;
    }

    const saveVersion = dirtyVersionRef.current;

    if (saveVersion === savedVersionRef.current) {
      return;
    }

    autoSaveInFlightRef.current = true;
    autoSaveQueuedRef.current = false;
    setSaveStatus("saving");
    setSaveError("");

    try {
      await saveCurrentBillingWorkspace({
        activeClassId: snapshot.activeClassId,
        branchId: snapshot.activeBranchId,
        clientSaveVersion: saveVersion,
        dismissedDoubleCourseRows: snapshot.dismissedDoubleCourseRows,
        feeOptions: snapshot.feeOptions,
        invoiceState: snapshot.invoiceState,
        orgId: snapshot.orgId,
        result: snapshot.result,
        savedByClientId: STUDENTS_COURSES_CLIENT_ID,
        savedByUid: snapshot.savedByUid,
        selectedInvoiceRowId: snapshot.selectedInvoiceRowId,
      });
      await syncStudentAccountsFromClassSheets({
        branch: snapshot.selectedBranch,
        classSheets: snapshot.result.classSheets,
        orgId: snapshot.orgId,
        savedByUid: snapshot.savedByUid,
      });

      if (dirtyVersionRef.current === saveVersion) {
        savedVersionRef.current = saveVersion;
        setHasUnsavedChanges(false);
        setSaveStatus("saved");
      } else {
        autoSaveQueuedRef.current = true;
        setSaveStatus("idle");
      }
    } catch (error) {
      console.error("Unable to auto-save billing workspace:", error);
      setSaveError("自動儲存失敗。請確認網路與 Firestore 權限。");
      setSaveStatus("error");
    } finally {
      autoSaveInFlightRef.current = false;

      if (
        autoSaveQueuedRef.current &&
        dirtyVersionRef.current !== savedVersionRef.current
      ) {
        autoSaveQueuedRef.current = false;
        if (autoSaveRetryTimerRef.current) {
          window.clearTimeout(autoSaveRetryTimerRef.current);
        }

        autoSaveRetryTimerRef.current = window.setTimeout(() => {
          autoSaveRetryTimerRef.current = null;
          void runAutoSaveRef.current?.();
        }, 500);
      }
    }
  }, []);

  useEffect(() => {
    runAutoSaveRef.current = runAutoSave;

    return () => {
      if (runAutoSaveRef.current === runAutoSave) {
        runAutoSaveRef.current = null;
      }

      if (autoSaveRetryTimerRef.current) {
        window.clearTimeout(autoSaveRetryTimerRef.current);
        autoSaveRetryTimerRef.current = null;
      }
    };
  }, [runAutoSave]);

  useEffect(() => {
    if (
      !hasUnsavedChanges ||
      !result ||
      !invoiceState ||
      !activeBranchId ||
      !workspace?.activeOrgId
    ) {
      return undefined;
    }

    if (autoSaveTimerRef.current) {
      window.clearTimeout(autoSaveTimerRef.current);
    }

    autoSaveTimerRef.current = window.setTimeout(() => {
      autoSaveTimerRef.current = null;
      void runAutoSave();
    }, 700);

    return () => {
      if (autoSaveTimerRef.current) {
        window.clearTimeout(autoSaveTimerRef.current);
        autoSaveTimerRef.current = null;
      }
    };
  }, [
    activeBranchId,
    dismissedDoubleCourseRows,
    feeOptions,
    hasUnsavedChanges,
    invoiceState,
    result,
    runAutoSave,
    selectedInvoiceRow?.id,
    selectedInvoiceRowId,
    workspace?.activeOrgId,
  ]);

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
    setFeeOptions(withAutomaticFeeOptions([]));
    setActiveClassId("");
    setSelectedInvoiceRowId("");
    setAttendancePreviewTarget(null);
    setDismissedDoubleCourseRows([]);
    setSaveStatus("idle");
    setSaveError("");
    setHasUnsavedChanges(false);

    if (!file) {
      return;
    }

    if (!activeBranchId) {
      setImportError("請先選擇或新增分校，再建立學生收費資料。");
      setImportStatus("idle");
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
      const nextFeeOptions = withAutomaticFeeOptions(organized.feeItems);

      setResult(organized);
      setInvoiceState(createInvoiceState(organized));
      setFeeOptions(nextFeeOptions);
      setActiveClassId(firstClass?.id || "");
      setSelectedInvoiceRowId(firstRow?.id || "");
      setImportStatus("ready");
      setShowCompactImport(false);
      await persistBranchFeeOptions(nextFeeOptions);
      markWorkspaceDirty();
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

  const selectBranch = (branchId) => {
    if (branchId === activeBranchId) {
      return;
    }

    if (
      hasUnsavedChanges &&
      !window.confirm("目前分校仍有尚未完成的自動儲存。確定要切換分校嗎？")
    ) {
      return;
    }

    setActiveBranchId(branchId);
  };

  const handleBranchFormChange = (event) => {
    setBranchForm({ name: event.target.value });
    setBranchError("");
  };

  const handleCreateBranch = async (event) => {
    event.preventDefault();
    const branchName = branchForm.name.trim();

    if (!branchName || branchSaveStatus === "saving") {
      return;
    }

    setBranchSaveStatus("saving");
    setBranchError("");

    try {
      const branch = await createOrganizationBranch({
        createdByUid: currentUser?.uid,
        name: branchName,
        orgId: workspace.activeOrgId,
      });
      const loadedWorkspace = await loadOrganizationWorkspace(currentUser);

      setWorkspace(loadedWorkspace);
      setActiveBranchId(branch.id);
      setBranchForm({ name: "" });
      setBranchModalOpen(false);
      setBranchSaveStatus("idle");
    } catch (error) {
      console.error("Unable to create branch:", error);
      setBranchError("無法新增分校。請確認你有組織管理權限後再試一次。");
      setBranchSaveStatus("error");
    }
  };

  const handleClassFormChange = (event) => {
    const { name, value } = event.target;
    setClassForm((current) => ({ ...current, [name]: value }));
  };

  const handleClassCourseChange = (courseRowId, event) => {
    const { name, value } = event.target;
    setClassForm((current) => ({
      ...current,
      courseRows: current.courseRows.map((course) =>
        course.id === courseRowId ? { ...course, [name]: value } : course,
      ),
    }));
  };

  const addClassCourseRow = () => {
    setClassForm((current) => ({
      ...current,
      courseRows: [...current.courseRows, createClassCourseFormRow()],
    }));
  };

  const removeClassCourseRow = (courseRowId) => {
    setClassForm((current) => {
      const nextCourseRows = current.courseRows.filter(
        (course) => course.id !== courseRowId,
      );

      return {
        ...current,
        courseRows: nextCourseRows.length
          ? nextCourseRows
          : [createClassCourseFormRow()],
      };
    });
  };

  const handleStudentFormChange = (event) => {
    const { name, value } = event.target;
    setStudentForm((current) => ({ ...current, [name]: value }));
  };

  const handleCreateClass = (event) => {
    event.preventDefault();
    const className = classForm.className.trim();

    if (!className || !activeBranchId) {
      return;
    }

    const nextSheet = createManualClassSheet({
      ...classForm,
      className,
    });
    const nextDraft = createManualClassDraft(nextSheet);

    setResult((current) => {
      const nextResult = current
        ? {
            ...current,
            fileName:
              current.fileName === "系統手動建立"
                ? current.fileName
                : `${current.fileName} + 手動建立`,
            classSheets: [...current.classSheets, nextSheet],
          }
        : createResultShell({
            classSheets: [nextSheet],
            feeItems: feeOptions.filter((option) => !option.automatic),
          });

      return refreshResultSummary(nextResult);
    });
    setInvoiceState((current) => ({
      ...(current || createEmptyInvoiceState()),
      classes: {
        ...(current?.classes || {}),
        [nextSheet.id]: nextDraft,
      },
    }));
    setActiveClassId(nextSheet.id);
    setSelectedInvoiceRowId("");
    setClassForm(createBlankClassForm());
    setClassModalOpen(false);
    setImportStatus("ready");
    setShowCompactImport(false);
    markWorkspaceDirty();
  };

  const handleAddStudent = (event) => {
    event.preventDefault();
    const studentName = studentForm.studentName.trim();

    if (!selectedClassSheet || !studentName) {
      return;
    }

    const studentNumber =
      studentForm.studentNumber.trim() ||
      String(selectedClassSheet.studentRows.length + 1);
    const rowId = createStudentRowId(selectedClassSheet.id);
    const studentId = createStudentAccountId();
    const courseSelections = Object.fromEntries(
      selectedClassSheet.courseBlocks.map((course) => [course.id, true]),
    );
    const courseDates = Object.fromEntries(
      selectedClassSheet.courseBlocks.map((course) => [
        course.id,
        selectedClassDraft?.globalDates[course.id] || [],
      ]),
    );
    const nextRow = {
      id: rowId,
      rowNumber: selectedClassSheet.studentRows.length + 2,
      studentId,
      studentNumber,
      studentName,
      subjects: [
        ...new Set(selectedClassSheet.courseBlocks.map(getCourseChoiceLabel)),
      ],
      courseDates,
      feeReferences: [],
      customFees: [],
    };

    setResult((current) =>
      refreshResultSummary({
        ...current,
        classSheets: current.classSheets.map((sheet) =>
          sheet.id === selectedClassSheet.id
            ? {
                ...sheet,
                studentRows: [...sheet.studentRows, nextRow],
                studentCount: sheet.studentRows.length + 1,
              }
            : sheet,
        ),
      }),
    );
    setInvoiceState((current) => ({
      ...current,
      classes: {
        ...current.classes,
        [selectedClassSheet.id]: {
          ...current.classes[selectedClassSheet.id],
          studentDates: {
            ...current.classes[selectedClassSheet.id].studentDates,
            [rowId]: courseDates,
          },
          studentCourseSelections: {
            ...(current.classes[selectedClassSheet.id].studentCourseSelections ||
              {}),
            [rowId]: courseSelections,
          },
          studentAttendanceGroupsByCourse: {
            ...(current.classes[selectedClassSheet.id]
              .studentAttendanceGroupsByCourse || {}),
            ...Object.fromEntries(
              selectedClassSheet.courseBlocks.map((course) => [
                course.id,
                {
                  ...(current.classes[selectedClassSheet.id]
                    .studentAttendanceGroupsByCourse?.[course.id] || {}),
                  [rowId]: "A",
                },
              ]),
            ),
          },
          studentFeeCodes: {
            ...current.classes[selectedClassSheet.id].studentFeeCodes,
            [rowId]: [],
          },
          studentCustomFees: {
            ...current.classes[selectedClassSheet.id].studentCustomFees,
            [rowId]: [],
          },
        },
      },
    }));
    setSelectedInvoiceRowId(rowId);
    setStudentForm(EMPTY_STUDENT_FORM);
    setStudentModalOpen(false);
    markWorkspaceDirty();
  };

  const handleDeleteStudent = (row) => {
    if (!selectedClassSheet || !selectedClassDraft) {
      return;
    }

    const remainingRows = selectedClassSheet.studentRows
      .filter((studentRow) => studentRow.id !== row.id)
      .map((studentRow, index) => ({
        ...studentRow,
        rowNumber: index + 2,
      }));
    const nextSelectedRowId =
      selectedInvoiceRowId === row.id
        ? remainingRows[0]?.id || ""
        : selectedInvoiceRowId;

    setResult((current) =>
      refreshResultSummary({
        ...current,
        classSheets: current.classSheets.map((sheet) =>
          sheet.id === selectedClassSheet.id
            ? {
                ...sheet,
                studentRows: remainingRows,
                studentCount: remainingRows.length,
              }
            : sheet,
        ),
      }),
    );
    setInvoiceState((current) => {
      if (!current) {
        return current;
      }

      const classDraft = current.classes[selectedClassSheet.id];

      if (!classDraft) {
        return current;
      }

      return {
        ...current,
        classes: {
          ...current.classes,
          [selectedClassSheet.id]: {
            ...classDraft,
            studentCourseSelections: withoutRecordKey(
              classDraft.studentCourseSelections,
              row.id,
            ),
            studentAttendanceGroups: withoutRecordKey(
              classDraft.studentAttendanceGroups,
              row.id,
            ),
            studentAttendanceGroupsByCourse: withoutNestedRecordKey(
              classDraft.studentAttendanceGroupsByCourse,
              row.id,
            ),
            studentCustomFees: withoutRecordKey(
              classDraft.studentCustomFees,
              row.id,
            ),
            studentDates: withoutRecordKey(classDraft.studentDates, row.id),
            studentFeeCodes: withoutRecordKey(
              classDraft.studentFeeCodes,
              row.id,
            ),
          },
        },
      };
    });
    setDismissedDoubleCourseRows((current) =>
      current.filter((rowId) => rowId !== row.id),
    );
    setSelectedInvoiceRowId(nextSelectedRowId);
    setStudentDeleteTarget(null);
    markWorkspaceDirty();
  };

  const toggleCourseAttendanceGroups = (courseId) => {
    if (!selectedClassSheet || !selectedClassDraft || !courseId) {
      return;
    }

    markWorkspaceDirty();
    updateSelectedClassDraft((classDraft) => ({
      ...classDraft,
      attendanceGroupEnabledByCourse: {
        ...createCourseAttendanceEnabledMap(selectedClassSheet),
        ...(classDraft.attendanceGroupEnabledByCourse || {}),
        [courseId]: !isCourseAttendanceGroupsEnabled(classDraft, courseId),
      },
      studentAttendanceGroupsByCourse: {
        ...(classDraft.studentAttendanceGroupsByCourse || {}),
        [courseId]: {
          ...createStudentAttendanceGroupsByCourse(selectedClassSheet)[courseId],
          ...(classDraft.studentAttendanceGroupsByCourse?.[courseId] || {}),
        },
      },
    }));
  };

  const updateStudentCourseAttendanceGroup = (rowId, courseId, group) => {
    if (!selectedClassSheet || !courseId || !["A", "B"].includes(group)) {
      return;
    }

    markWorkspaceDirty();
    updateSelectedClassDraft((classDraft) => ({
      ...classDraft,
      attendanceGroupEnabledByCourse: {
        ...createCourseAttendanceEnabledMap(selectedClassSheet),
        ...(classDraft.attendanceGroupEnabledByCourse || {}),
        [courseId]: true,
      },
      studentAttendanceGroupsByCourse: {
        ...(classDraft.studentAttendanceGroupsByCourse || {}),
        [courseId]: {
          ...createStudentAttendanceGroupsByCourse(selectedClassSheet)[courseId],
          ...(classDraft.studentAttendanceGroupsByCourse?.[courseId] || {}),
          [rowId]: group,
        },
      },
    }));
  };

  const addGlobalDate = (courseId) => {
    const date = dateDrafts[courseId];
    const course = selectedClassSheet?.courseBlocks.find(
      (item) => item.id === courseId,
    );

    if (!date || !course) {
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
              [courseId]: isStudentCourseSelected(classDraft, rowId, course)
                ? sortDates([...(courses[courseId] || []), date])
                : courses[courseId] || [],
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

  const toggleStudentCourse = (rowId, course) => {
    markWorkspaceDirty();
    updateSelectedClassDraft((classDraft) => {
      const currentlySelected = isStudentCourseSelected(
        classDraft,
        rowId,
        course,
      );
      const nextSelected = !currentlySelected;
      const currentStudentDates = classDraft.studentDates[rowId] || {};
      const nextCourseDates = nextSelected
        ? sortDates([
            ...(classDraft.globalDates[course.id] || []),
            ...(currentStudentDates[course.id] || []),
          ])
        : [];
      const nextDraft = {
        ...classDraft,
        studentCourseSelections: {
          ...(classDraft.studentCourseSelections || {}),
          [rowId]: {
            ...(classDraft.studentCourseSelections?.[rowId] || {}),
            [course.id]: nextSelected,
          },
        },
        studentDates: {
          ...classDraft.studentDates,
          [rowId]: {
            ...currentStudentDates,
            [course.id]: nextCourseDates,
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
    const nextFeeOptions = [
      ...feeOptions.filter(
        (option) => option.code !== editingFeeCode && option.code !== code,
      ),
      nextOption,
    ].sort(compareFeeOptions);

    setFeeOptions(nextFeeOptions);
    void persistBranchFeeOptions(nextFeeOptions);

    if (editingFeeCode && editingFeeCode !== code) {
      markWorkspaceDirty();
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
    const nextFeeOptions = feeOptions.filter((option) => option.code !== code);

    setFeeOptions(nextFeeOptions);
    void persistBranchFeeOptions(nextFeeOptions);

    if (result && invoiceState) {
      markWorkspaceDirty();
    }

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

  const openInvoiceNoticeModal = (rowId = "") => {
    if (rowId) {
      setSelectedInvoiceRowId(rowId);
    }

    setInvoiceNoticeError("");
    setInvoiceNoticeStatus("idle");
    setLastGeneratedInvoiceId("");
    setInvoicePreviewOpen(true);
  };

  const handleGenerateInvoiceNotice = async () => {
    if (
      !selectedInvoiceRow ||
      !selectedClassSheet ||
      !selectedBranch ||
      !workspace?.activeOrgId ||
      invoiceNoticeStatus === "saving"
    ) {
      return;
    }

    setInvoiceNoticeError("");
    setInvoiceNoticeStatus("saving");

    try {
      const saved = await saveStudentInvoiceNotice({
        branch: selectedBranch,
        classSheet: selectedClassSheet,
        generatedByEmail: currentUser?.email || "",
        generatedByUid: currentUser?.uid || "",
        invoice: selectedInvoiceRow.invoice,
        organization: workspace.organization,
        orgId: workspace.activeOrgId,
        studentRow: selectedInvoiceRow,
      });

      setLastGeneratedInvoiceId(saved.invoiceId);
      setInvoiceNoticeStatus("saved");
    } catch (error) {
      console.error("Unable to generate invoice notice:", error);
      setInvoiceNoticeError(
        "無法產生繳費通知單。請確認網路與 Firestore 權限後再試一次。",
      );
      setInvoiceNoticeStatus("error");
    }
  };

  const renderClassCourseFields = ({ autoFocusClassName = false } = {}) => (
    <>
      <label>
        班級
        <input
          autoFocus={autoFocusClassName}
          name="className"
          onChange={handleClassFormChange}
          placeholder="例如：國一"
          value={classForm.className}
        />
      </label>
      <div className="class-course-form-list">
        <div className="class-course-form-heading">
          <span>科目與課程名稱</span>
          <button
            className="secondary-course-button"
            onClick={addClassCourseRow}
            type="button"
          >
            + 新增科目
          </button>
        </div>
        {classForm.courseRows.map((course, index) => (
          <div className="class-course-form-row" key={course.id}>
            <label>
              科目 {index + 1}
              <select
                name="subjectCode"
                onChange={(event) => handleClassCourseChange(course.id, event)}
                value={course.subjectCode}
              >
                {SUBJECT_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              課程名稱
              <input
                name="courseName"
                onChange={(event) => handleClassCourseChange(course.id, event)}
                placeholder="例如：數學 一/四"
                value={course.courseName}
              />
            </label>
            {classForm.courseRows.length > 1 ? (
              <button
                className="class-course-remove-button"
                onClick={() => removeClassCourseRow(course.id)}
                type="button"
              >
                移除
              </button>
            ) : null}
          </div>
        ))}
      </div>
    </>
  );

  const renderFeeOptionsManager = ({ modal = false } = {}) => (
    <section className={`fee-options-manager ${modal ? "modal-fee-manager" : ""}`}>
      <div className="panel-heading">
        <p className="dashboard-kicker">雜項表管理</p>
        <h2>可套用選項</h2>
        <p>這裡管理系統可選的雜項代碼、名稱、金額與備註。</p>
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
                  <button onClick={() => editFeeOption(option)} type="button">
                    編輯
                  </button>
                  <button onClick={() => deleteFeeOption(option.code)} type="button">
                    移除
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );

  const renderStudentInvoiceHistory = () => (
    <section className="student-invoice-history">
      <div className="student-invoice-history-heading">
        <div>
          <p className="dashboard-kicker">學生通知單紀錄</p>
          <h3>已產生的繳費通知單</h3>
        </div>
        <span>{studentInvoiceHistory.length}</span>
      </div>

      {studentInvoiceHistoryStatus === "loading" ? (
        <p className="invoice-history-state">正在載入通知單紀錄...</p>
      ) : null}

      {studentInvoiceHistoryStatus === "error" ? (
        <p className="invoice-history-state error">
          無法載入通知單紀錄。請確認 Firestore 權限。
        </p>
      ) : null}

      {studentInvoiceHistoryStatus === "ready" &&
      studentInvoiceHistory.length === 0 ? (
        <p className="invoice-history-state">
          此學生尚未有已產生的繳費通知單。
        </p>
      ) : null}

      {studentInvoiceHistory.length ? (
        <div className="student-invoice-history-list">
          {studentInvoiceHistory.map((invoice) => (
            <article
              className={
                invoice.id === lastGeneratedInvoiceId
                  ? "student-invoice-history-item latest"
                  : "student-invoice-history-item"
              }
              key={invoice.id}
            >
              <div>
                <strong>{invoice.invoiceNumber}</strong>
                <span>
                  {invoice.sourceBranchSnapshot?.name || "未記錄分校"} ·{" "}
                  {invoice.className || "未記錄班級"} ·{" "}
                  {formatDateTime(invoice.issuedAtIso)}
                </span>
              </div>
              <div>
                <em className={`invoice-status-chip ${invoice.status || "unpaid"}`}>
                  {getInvoiceStatusLabel(invoice.status)}
                </em>
                <strong>{formatCurrency(Number(invoice.balance ?? invoice.total) || 0)}</strong>
              </div>
            </article>
          ))}
        </div>
      ) : null}
    </section>
  );

  const renderInvoiceNoticePreview = () => {
    if (!selectedInvoiceRow || !selectedClassSheet) {
      return null;
    }

    return (
      <div className="invoice-print-area">
        <header>
          <p>{workspace.organization.name}</p>
          <h2>繳費通知單</h2>
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
          產生後會儲存在學生帳戶。列印、收款與收據請到每日收支處理。
        </p>
      </div>
    );
  };

  const renderAttendanceRosterPreview = () => {
    if (!selectedClassSheet || !selectedClassDraft || !attendancePreviewTarget) {
      return null;
    }

    const course = selectedClassSheet.courseBlocks.find(
      (item) => item.id === attendancePreviewTarget.courseId,
    );

    if (!course) {
      return null;
    }

    const dateColumns = getAttendanceDateColumns(selectedClassDraft, course.id);
    const groupedRows = invoiceRows.filter(
      (row) =>
        isStudentCourseSelected(selectedClassDraft, row.id, course) &&
        getStudentCourseAttendanceGroup(selectedClassDraft, course.id, row.id) ===
          attendancePreviewTarget.group,
    );
    const rowCount = Math.max(25, groupedRows.length);
    const displayRows = Array.from(
      { length: rowCount },
      (_, index) => groupedRows[index] || null,
    );

    return (
      <div className="invoice-print-area attendance-print-area">
        <h2>互動文理點名單</h2>
        <div className="attendance-roster-meta">
          班級：{selectedClassSheet.name} {course.label}{" "}
          {getAttendanceGroupLabel(attendancePreviewTarget.group)}
          <span>班時間：</span>
          <span>老師：</span>
        </div>
        <table>
          <thead>
            <tr>
              <th>編號</th>
              <th>姓名</th>
              {dateColumns.map((column) => (
                <th key={column.id}>{column.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {displayRows.map((row, index) => (
              <tr key={row?.id || `blank-row-${index}`}>
                <td>{index + 1}.</td>
                <td>{row?.studentName || ""}</td>
                {dateColumns.map((column) => (
                  <td key={column.id} />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        <p className="attendance-roster-note">
          ※請假的同學，請老師盡快補課，將補課日期記錄在格子內。
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
            <h1 id="students-title">{pageTitle}</h1>
            <p>{pageDescription}</p>
          </div>
          <span>
            {workspace.organization.name}
            {selectedBranch ? ` · ${selectedBranch.name}` : ""}
          </span>
        </div>

        <input
          accept=".xlsx"
          aria-label="選擇學費袋 Excel"
          className="sr-only"
          onChange={(event) => handleFile(event.target.files?.[0])}
          ref={inputRef}
          type="file"
        />

        <section className="branch-workspace-panel" aria-labelledby="branch-title">
          <div>
            <p className="dashboard-kicker">分校</p>
            <h2 id="branch-title">
              {selectedBranch ? selectedBranch.name : "請選擇分校"}
            </h2>
            <p>
              每個分校都有自己的班級、學生、全班日期、雜項套用與儲存資料。
            </p>
          </div>
          <div className="branch-switch-row" aria-label="選擇分校">
            {branchOptions.map((branch) => (
              <button
                aria-pressed={selectedBranch?.id === branch.id}
                className={selectedBranch?.id === branch.id ? "active" : ""}
                key={branch.id}
                onClick={() => selectBranch(branch.id)}
                type="button"
              >
                {branch.name}
              </button>
            ))}
            {canManageBranches ? (
              <button
                className="add-branch-button"
                onClick={() => {
                  setBranchForm({ name: "" });
                  setBranchError("");
                  setBranchSaveStatus("idle");
                  setBranchModalOpen(true);
                }}
                type="button"
              >
                + 新增分校
              </button>
            ) : null}
          </div>
        </section>

        {!hasSelectedBranch ? (
          <section className="dashboard-message-panel inline branch-empty-panel">
            <p className="dashboard-kicker">下一步</p>
            <h1>先建立第一個分校</h1>
            <p>
              組織建立後，請先新增分校。每個分校會有自己的學生、班級與繳費資料。
            </p>
          </section>
        ) : null}

        {hasSelectedBranch && savedWorkspaceLoading ? (
          <section className="dashboard-message-panel inline branch-loading-panel">
            <p className="dashboard-kicker">載入中</p>
            <h1>正在讀取分校資料</h1>
            <p>
              正在確認
              {selectedBranch ? `「${selectedBranch.name}」` : "目前分校"}
              是否已有班級、學生與收費資料。
            </p>
          </section>
        ) : null}

        {hasSelectedBranch && !savedWorkspaceLoading && !result ? (
          <>
            <div className="import-stepper platform-stepper" aria-label="工作流程">
              <UploadStep active title="1. 建立資料">
                匯入 Excel 或手動建立第一個班級。
              </UploadStep>
              <UploadStep active={false} title="2. 自動儲存">
                匯入或修改後會自動儲存到目前分校。
              </UploadStep>
              <UploadStep active={false} title="3. 日常收費">
                之後直接進入班級工作台。
              </UploadStep>
            </div>

            <section className="first-setup-grid">
              <section
                className={`upload-dropzone setup-upload ${
                  dragging ? "dragging" : ""
                }`}
                onDragEnter={(event) => {
                  event.preventDefault();
                  setDragging(true);
                }}
                onDragOver={(event) => event.preventDefault()}
                onDragLeave={() => setDragging(false)}
                onDrop={handleDrop}
              >
                <div className="upload-icon" aria-hidden="true">
                  ↑
                </div>
                <h2>第一次匯入學費袋 Excel</h2>
                <p>如果已有 Excel，這是最快的初始化方式。匯入後會自動儲存到目前分校。</p>
                <button
                  className="upload-picker-button"
                  onClick={() => inputRef.current?.click()}
                  type="button"
                >
                  選擇 Excel
                </button>
                {importStatus === "parsing" ? (
                  <p className="upload-status">正在整理資料...</p>
                ) : null}
                {savedWorkspaceErrorForBranch ? (
                  <p className="auth-error">
                    無法載入已儲存資料。仍可重新匯入 Excel。
                  </p>
                ) : null}
                {importError ? <p className="auth-error">{importError}</p> : null}
              </section>

              <section className="manual-setup-panel">
                <div className="panel-heading">
                  <p className="dashboard-kicker">手動建立</p>
                  <h2>建立第一個班級</h2>
                  <p>沒有 Excel 時，可以先建立班級，再逐位加入學生。</p>
                </div>
                <form className="manual-class-form" onSubmit={handleCreateClass}>
                  {renderClassCourseFields()}
                  <button type="submit">建立班級</button>
                </form>
              </section>
            </section>

            {renderFeeOptionsManager()}
          </>
        ) : null}

        {hasSelectedBranch &&
        !savedWorkspaceLoading &&
        result &&
        selectedClassSheet &&
        selectedClassDraft ? (
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
                  <span>本班學生</span>
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
                  className="confirm-import-button"
                  onClick={() => openInvoiceNoticeModal(selectedInvoiceRow?.id)}
                  type="button"
                >
                  產生繳費通知單
                </button>
                <button
                  className="compact-import-button"
                  onClick={() => setShowCompactImport((current) => !current)}
                  type="button"
                >
                  匯入
                </button>
                <p
                  className={`workspace-save-note ${
                    hasUnsavedChanges || saveStatus === "error" ? "unsaved" : ""
                  }`}
                >
                  {saveError ||
                    (saveStatus === "saving"
                      ? "正在自動儲存..."
                      : hasUnsavedChanges
                        ? "等待自動儲存..."
                        : "已自動儲存。重新整理後不需要再匯入 Excel。")}
                </p>
              </div>
            </div>

            {showCompactImport ? (
              <section
                className={`compact-import-panel ${
                  dragging ? "dragging" : ""
                }`}
                onDragEnter={(event) => {
                  event.preventDefault();
                  setDragging(true);
                }}
                onDragOver={(event) => event.preventDefault()}
                onDragLeave={() => setDragging(false)}
                onDrop={handleDrop}
              >
                <div>
                  <p className="dashboard-kicker">Excel 工具</p>
                  <h2>重新匯入或更換資料來源</h2>
                  <p>
                    只有第一次或需要重建資料時才使用。平常請直接在工作台維護資料。
                  </p>
                </div>
                <button
                  className="upload-picker-button"
                  onClick={() => inputRef.current?.click()}
                  type="button"
                >
                  選擇 Excel
                </button>
                {importStatus === "parsing" ? (
                  <p className="upload-status">正在整理資料...</p>
                ) : null}
                {importError ? <p className="auth-error">{importError}</p> : null}
              </section>
            ) : null}

            <div className="class-tab-row" aria-label="班級">
              {result.classSheets.map((sheet) => (
                <button
                  aria-pressed={selectedClassSheet.id === sheet.id}
                  className={selectedClassSheet.id === sheet.id ? "active" : ""}
                  key={sheet.id}
                  onClick={() => {
                    setActiveClassId(sheet.id);
                    setSelectedInvoiceRowId(sheet.studentRows[0]?.id || "");
                    setDateModalCourseId("");
                    setAttendancePreviewTarget(null);
                    setStudentDeleteTarget(null);
                    setStudentModalOpen(false);
                  }}
                  type="button"
                >
                  {sheet.name}
                  <span>{sheet.studentCount}</span>
                </button>
              ))}
              <button
                className="add-class-tab-button"
                onClick={() => setClassModalOpen(true)}
                type="button"
              >
              + 新增班級
              </button>
            </div>

            <section className="invoice-sheet-panel invoice-sheet-panel-full">
                <div className="panel-heading table-panel-heading">
                  <div>
                  <p className="dashboard-kicker">班級表格</p>
                  <h2>收費資料</h2>
                  <p>
                    順序對齊 Excel：編號、姓名、科目、課程日期、雜項、合計。
                  </p>
                  </div>
                  <div className="table-panel-actions">
                    <button
                      className="table-panel-action-button"
                      onClick={() => {
                        setStudentForm(EMPTY_STUDENT_FORM);
                        setStudentModalOpen(true);
                      }}
                      title={`新增學生到 ${selectedClassSheet.name}`}
                      type="button"
                    >
                      + 學生
                    </button>
                    <button
                      className="table-panel-action-button secondary-table-action"
                      onClick={() => setFeeModalOpen(true)}
                      title="管理雜項表"
                      type="button"
                    >
                      雜項
                    </button>
                  </div>
                </div>
                <div className="invoice-sheet-wrap">
                  <table
                    className={`invoice-sheet-table ${
                      hasCourseAttendanceGroupsEnabled
                        ? "attendance-enabled"
                        : ""
                    }`}
                  >
                    <thead>
                      <tr>
                        <th>編號</th>
                        <th>姓名</th>
                        <th>科目</th>
                        {selectedClassSheet.courseBlocks.map((course) => (
                          <th key={course.id}>
                            <div className="course-header-cell">
                              <span>{course.label}</span>
                              <div className="course-header-actions">
                                <button
                                  aria-label={`修改 ${course.label} 全班日期`}
                                  onClick={() => setDateModalCourseId(course.id)}
                                  title={`修改 ${course.label} 全班日期`}
                                  type="button"
                                >
                                  日
                                </button>
                                <button
                                  aria-pressed={
                                    courseAttendanceEnabledMap[course.id]
                                  }
                                  className={
                                    courseAttendanceEnabledMap[course.id]
                                      ? "active-toggle"
                                      : ""
                                  }
                                  onClick={() =>
                                    toggleCourseAttendanceGroups(course.id)
                                  }
                                  title={
                                    courseAttendanceEnabledMap[course.id]
                                      ? `停用 ${course.label} A/B 分班`
                                      : `啟用 ${course.label} A/B 分班`
                                  }
                                  type="button"
                                >
                                  AB
                                </button>
                                {courseAttendanceEnabledMap[course.id]
                                  ? ATTENDANCE_GROUP_OPTIONS.map((option) => (
                                      <button
                                        key={option.value}
                                        onClick={() =>
                                          setAttendancePreviewTarget({
                                            courseId: course.id,
                                            group: option.value,
                                          })
                                        }
                                        title={`產生 ${course.label}${option.label} 點名表`}
                                        type="button"
                                      >
                                        {option.value}
                                      </button>
                                    ))
                                  : null}
                              </div>
                              <small>
                                {(
                                  selectedClassDraft.globalDates[course.id] ||
                                  []
                                ).length}{" "}
                                日期
                              </small>
                            </div>
                          </th>
                        ))}
                        <th>雜項</th>
                        <th>合計</th>
                        <th>操作</th>
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
                            <td>
                              <span className="student-name-cell">
                                <strong>{row.studentName}</strong>
                                <em title={`學生唯一 ID：${row.studentId}`}>
                                  ID {getShortStudentId(row.studentId)}
                                </em>
                              </span>
                            </td>
                            <td>
                              <div
                                aria-label={`${row.studentName} 科目`}
                                className="subject-toggle-grid"
                              >
                                {selectedClassSheet.courseBlocks.map((course) => {
                                  const selected = isStudentCourseSelected(
                                    selectedClassDraft,
                                    row.id,
                                    course,
                                  );

                                  return (
                                    <button
                                      aria-pressed={selected}
                                      className={selected ? "active" : ""}
                                      key={course.id}
                                      onClick={() =>
                                        toggleStudentCourse(row.id, course)
                                      }
                                      title={course.label}
                                      type="button"
                                    >
                                      {getCourseChoiceLabel(course)}
                                    </button>
                                  );
                                })}
                              </div>
                            </td>
                            {selectedClassSheet.courseBlocks.map((course) => {
                              const courseSelected = isStudentCourseSelected(
                                selectedClassDraft,
                                row.id,
                                course,
                              );
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
                              ) || {
                                sessionCount: 0,
                                amount: 0,
                              };

                              return (
                                <td className="course-date-cell" key={course.id}>
                                  {courseSelected ? (
                                    <>
                                      {courseAttendanceEnabledMap[course.id] ? (
                                        <div className="course-attendance-row">
                                          <span>分班</span>
                                          <div
                                            aria-label={`${row.studentName} ${course.label} 分班`}
                                            className="attendance-group-toggle"
                                          >
                                            {ATTENDANCE_GROUP_OPTIONS.map(
                                              (option) => {
                                                const selected =
                                                  getStudentCourseAttendanceGroup(
                                                    selectedClassDraft,
                                                    course.id,
                                                    row.id,
                                                  ) === option.value;

                                                return (
                                                  <button
                                                    aria-pressed={selected}
                                                    className={
                                                      selected ? "active" : ""
                                                    }
                                                    key={option.value}
                                                    onClick={() =>
                                                      updateStudentCourseAttendanceGroup(
                                                        row.id,
                                                        course.id,
                                                        option.value,
                                                      )
                                                    }
                                                    type="button"
                                                  >
                                                    {option.value}
                                                  </button>
                                                );
                                              },
                                            )}
                                          </div>
                                        </div>
                                      ) : null}
                                      {visibleDates.length ? (
                                        <div className="date-toggle-grid">
                                          {visibleDates.map((date) => (
                                            <button
                                              className={
                                                rowDates.includes(date)
                                                  ? "active"
                                                  : ""
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
                                      ) : (
                                        <p className="course-disabled-note">
                                          尚未設定日期
                                        </p>
                                      )}
                                      <p className="cell-total">
                                        {courseLine.sessionCount} 堂 /{" "}
                                        {formatCurrency(courseLine.amount)}
                                      </p>
                                    </>
                                  ) : (
                                    <p className="course-disabled-note">未選</p>
                                  )}
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
                              <div className="student-row-actions">
                                <button
                                  className="table-action-button"
                                  onClick={() => openInvoiceNoticeModal(row.id)}
                                  type="button"
                                >
                                  預覽
                                </button>
                                <button
                                  className="table-action-button danger-table-action"
                                  onClick={() => setStudentDeleteTarget(row)}
                                  type="button"
                                >
                                  刪除
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                      {!invoiceRows.length ? (
                        <tr>
                          <td
                            className="empty-student-row"
                            colSpan={selectedClassSheet.courseBlocks.length + 6}
                          >
                            這個班級尚未有學生。請按右上方「+ 學生」加入第一位學生。
                          </td>
                        </tr>
                      ) : null}
                    </tbody>
                  </table>
                </div>
              </section>

          </section>
        ) : null}
        {classModalOpen ? (
          <div
            className="invoice-modal-backdrop"
            onClick={() => setClassModalOpen(false)}
          >
            <section
              aria-labelledby="class-modal-title"
              aria-modal="true"
              className="class-create-modal"
              onClick={(event) => event.stopPropagation()}
              role="dialog"
            >
              <div className="invoice-modal-heading">
                <div>
                  <p className="dashboard-kicker">新增班級</p>
                  <h2 id="class-modal-title">建立新的班級與課程</h2>
                  <p>建立後會出現在國一、國二等班級列中，學生再加入該班級。</p>
                </div>
                <button
                  className="modal-close-icon"
                  onClick={() => setClassModalOpen(false)}
                  type="button"
                >
                  關閉
                </button>
              </div>
              <form className="manual-class-form modal-class-form" onSubmit={handleCreateClass}>
                {renderClassCourseFields({ autoFocusClassName: true })}
                <div className="modal-form-actions">
                  <button type="submit">建立班級</button>
                  <button
                    className="secondary-modal-button"
                    onClick={() => setClassModalOpen(false)}
                    type="button"
                  >
                    取消
                  </button>
                </div>
              </form>
            </section>
          </div>
        ) : null}
        {branchModalOpen ? (
          <div
            className="invoice-modal-backdrop"
            onClick={() => setBranchModalOpen(false)}
          >
            <section
              aria-labelledby="branch-modal-title"
              aria-modal="true"
              className="branch-create-modal"
              onClick={(event) => event.stopPropagation()}
              role="dialog"
            >
              <div className="invoice-modal-heading">
                <div>
                  <p className="dashboard-kicker">新增分校</p>
                  <h2 id="branch-modal-title">建立新的分校</h2>
                  <p>建立後會出現在分校列中，並擁有獨立的學生與課程資料。</p>
                </div>
                <button
                  className="modal-close-icon"
                  onClick={() => setBranchModalOpen(false)}
                  type="button"
                >
                  關閉
                </button>
              </div>
              <form
                className="branch-create-form"
                onSubmit={handleCreateBranch}
              >
                <label>
                  分校名稱
                  <input
                    autoFocus
                    name="name"
                    onChange={handleBranchFormChange}
                    placeholder="例如：四校"
                    value={branchForm.name}
                  />
                </label>
                {branchError ? <p className="auth-error">{branchError}</p> : null}
                <div className="modal-form-actions">
                  <button disabled={branchSaveStatus === "saving"} type="submit">
                    {branchSaveStatus === "saving" ? "建立中..." : "建立分校"}
                  </button>
                  <button
                    className="secondary-modal-button"
                    onClick={() => setBranchModalOpen(false)}
                    type="button"
                  >
                    取消
                  </button>
                </div>
              </form>
            </section>
          </div>
        ) : null}
        {studentModalOpen && selectedClassSheet ? (
          <div
            className="invoice-modal-backdrop"
            onClick={() => setStudentModalOpen(false)}
          >
            <section
              aria-labelledby="student-modal-title"
              aria-modal="true"
              className="student-create-modal"
              onClick={(event) => event.stopPropagation()}
              role="dialog"
            >
              <div className="invoice-modal-heading">
                <div>
                  <p className="dashboard-kicker">新增學生</p>
                  <h2 id="student-modal-title">
                    加入 {selectedClassSheet.name}
                  </h2>
                  <p>
                    新學生會預設加入本班全部科目，之後可在班級表格中調整。
                  </p>
                </div>
                <button
                  className="modal-close-icon"
                  onClick={() => setStudentModalOpen(false)}
                  type="button"
                >
                  關閉
                </button>
              </div>
              <form
                className="manual-student-form modal-student-form"
                onSubmit={handleAddStudent}
              >
                <div>
                  <p className="dashboard-kicker">預設科目</p>
                  <p className="class-course-summary">
                    {selectedClassSheet.courseBlocks
                      .map(getCourseChoiceLabel)
                      .join("、")}
                  </p>
                </div>
                <label>
                  編號
                  <input
                    autoFocus
                    name="studentNumber"
                    onChange={handleStudentFormChange}
                    placeholder="自動"
                    value={studentForm.studentNumber}
                  />
                </label>
                <label>
                  姓名
                  <input
                    name="studentName"
                    onChange={handleStudentFormChange}
                    placeholder="學生姓名"
                    value={studentForm.studentName}
                  />
                </label>
                <div className="modal-form-actions">
                  <button type="submit">新增學生</button>
                  <button
                    className="secondary-modal-button"
                    onClick={() => setStudentModalOpen(false)}
                    type="button"
                  >
                    取消
                  </button>
                </div>
              </form>
            </section>
          </div>
        ) : null}
        {studentDeleteTarget && selectedClassSheet ? (
          <div
            className="invoice-modal-backdrop"
            onClick={() => setStudentDeleteTarget(null)}
          >
            <section
              aria-labelledby="delete-student-modal-title"
              aria-modal="true"
              className="delete-student-modal"
              onClick={(event) => event.stopPropagation()}
              role="dialog"
            >
              <div className="invoice-modal-heading warning-modal-heading">
                <div>
                  <p className="dashboard-kicker">刪除學生</p>
                  <h2 id="delete-student-modal-title">確認刪除此學生？</h2>
                  <p>刪除後會從目前班級移除，並透過自動儲存更新資料庫。</p>
                </div>
                <button
                  className="modal-close-icon"
                  onClick={() => setStudentDeleteTarget(null)}
                  type="button"
                >
                  關閉
                </button>
              </div>

              <div className="delete-warning-body">
                <span aria-hidden="true" className="delete-warning-icon">
                  !
                </span>
                <div className="delete-warning-copy">
                  <strong>{studentDeleteTarget.studentName}</strong>
                  <span>
                    {selectedClassSheet.name} · 編號{" "}
                    {studentDeleteTarget.studentNumber || "未設定"}
                  </span>
                  <p>
                    這會移除此學生在本班的科目選取、課程日期、雜項套用與本期通知單資料。
                    如果只是暫時不收費，請取消科目或雜項，不需要刪除學生。
                  </p>
                </div>
              </div>

              <div className="modal-form-actions delete-modal-actions">
                <button
                  className="danger-modal-button"
                  onClick={() => handleDeleteStudent(studentDeleteTarget)}
                  type="button"
                >
                  刪除學生
                </button>
                <button
                  className="secondary-modal-button"
                  onClick={() => setStudentDeleteTarget(null)}
                  type="button"
                >
                  取消
                </button>
              </div>
            </section>
          </div>
        ) : null}
        {dateModalCourse && selectedClassDraft ? (
          <div
            className="invoice-modal-backdrop"
            onClick={() => setDateModalCourseId("")}
          >
            <section
              aria-labelledby="date-modal-title"
              aria-modal="true"
              className="course-date-modal"
              onClick={(event) => event.stopPropagation()}
              role="dialog"
            >
              <div className="invoice-modal-heading">
                <div>
                  <p className="dashboard-kicker">全班日期</p>
                  <h2 id="date-modal-title">{dateModalCourse.label}</h2>
                  <p>
                    新增日期會套用到已選此科目的學生，仍可在表格中逐位微調。
                  </p>
                </div>
                <button
                  className="modal-close-icon"
                  onClick={() => setDateModalCourseId("")}
                  type="button"
                >
                  關閉
                </button>
              </div>
              <form
                className="modal-date-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  addGlobalDate(dateModalCourse.id);
                }}
              >
                <div className="date-input-row">
                  <input
                    aria-label={`${dateModalCourse.label} 新增日期`}
                    autoFocus
                    onChange={(event) =>
                      setDateDrafts((current) => ({
                        ...current,
                        [dateModalCourse.id]: event.target.value,
                      }))
                    }
                    type="date"
                    value={dateDrafts[dateModalCourse.id] || ""}
                  />
                  <button type="submit">加入</button>
                </div>
                <div className="date-chip-list modal-date-chip-list">
                  {(selectedClassDraft.globalDates[dateModalCourse.id] || [])
                    .length ? (
                    selectedClassDraft.globalDates[dateModalCourse.id].map(
                      (date) => (
                        <button
                          key={date}
                          onClick={() =>
                            removeGlobalDate(dateModalCourse.id, date)
                          }
                          type="button"
                        >
                          {formatDateShort(date)} ×
                        </button>
                      ),
                    )
                  ) : (
                    <p className="course-disabled-note">尚未設定全班日期</p>
                  )}
                </div>
              </form>
            </section>
          </div>
        ) : null}
        {feeModalOpen ? (
          <div
            className="invoice-modal-backdrop"
            onClick={() => setFeeModalOpen(false)}
          >
            <section
              aria-labelledby="fee-modal-title"
              aria-modal="true"
              className="fee-manager-modal"
              onClick={(event) => event.stopPropagation()}
              role="dialog"
            >
              <div className="invoice-modal-heading">
                <div>
                  <p className="dashboard-kicker">雜項表管理</p>
                  <h2 id="fee-modal-title">管理可套用選項</h2>
                  <p>新增、編輯或移除收費表中可指派給學生的雜項。</p>
                </div>
                <button
                  className="modal-close-icon"
                  onClick={() => setFeeModalOpen(false)}
                  type="button"
                >
                  關閉
                </button>
              </div>
              {renderFeeOptionsManager({ modal: true })}
            </section>
          </div>
        ) : null}
        {attendancePreviewTarget && selectedClassSheet ? (
          <div
            className="invoice-modal-backdrop"
            onClick={() => setAttendancePreviewTarget(null)}
          >
            <section
              aria-labelledby="attendance-modal-title"
              aria-modal="true"
              className="invoice-preview-modal attendance-roster-modal"
              onClick={(event) => event.stopPropagation()}
              role="dialog"
            >
              <div className="invoice-modal-heading no-print">
                <div>
                  <p className="dashboard-kicker">點名表</p>
                  <h2 id="attendance-modal-title">
                    {selectedClassSheet.name}{" "}
                    {selectedClassSheet.courseBlocks.find(
                      (course) => course.id === attendancePreviewTarget.courseId,
                    )?.label || "課程"}{" "}
                    {getAttendanceGroupLabel(attendancePreviewTarget.group)}
                  </h2>
                  <p>
                    日期欄使用此課程已設定的全班日期，老師欄位先保留空白。
                  </p>
                </div>
                <div className="invoice-modal-actions">
                  <button onClick={() => window.print()} type="button">
                    列印
                  </button>
                  <button
                    className="secondary-modal-button"
                    onClick={() => setAttendancePreviewTarget(null)}
                    type="button"
                  >
                    關閉
                  </button>
                </div>
              </div>
              {renderAttendanceRosterPreview()}
            </section>
          </div>
        ) : null}
        {invoicePreviewOpen && selectedInvoiceRow ? (
          <div
            className="invoice-modal-backdrop"
            onClick={() => setInvoicePreviewOpen(false)}
          >
            <section
              aria-labelledby="invoice-modal-title"
              aria-modal="true"
              className="invoice-preview-modal"
              onClick={(event) => event.stopPropagation()}
              role="dialog"
            >
              <div className="invoice-modal-heading">
                <div>
                  <p className="dashboard-kicker">產生繳費通知單</p>
                  <h2 id="invoice-modal-title">
                    {selectedInvoiceRow.studentName}
                  </h2>
                  <p>
                    確認內容後會儲存到學生帳戶；列印、收款與收據請到每日收支處理。
                  </p>
                </div>
                <div className="invoice-modal-actions">
                  <button
                    disabled={
                      invoiceNoticeStatus === "saving" ||
                      !selectedStudentAccountId
                    }
                    onClick={handleGenerateInvoiceNotice}
                    type="button"
                  >
                    {invoiceNoticeStatus === "saving"
                      ? "產生中..."
                      : "產生繳費通知單"}
                  </button>
                  <button
                    className="secondary-modal-button"
                    onClick={() => setInvoicePreviewOpen(false)}
                    type="button"
                  >
                    關閉
                  </button>
                </div>
              </div>
              {invoiceNoticeStatus === "saved" ? (
                <div className="auth-banner success">
                  已產生繳費通知單，並儲存到學生帳戶。
                </div>
              ) : null}
              {!selectedStudentAccountId ? (
                <div className="auth-banner error">
                  這筆學生資料缺少唯一 ID。請重新匯入或重新新增學生後再產生通知單。
                </div>
              ) : null}
              {invoiceNoticeError ? (
                <div className="auth-banner error">{invoiceNoticeError}</div>
              ) : null}
              {renderInvoiceNoticePreview()}
              {renderStudentInvoiceHistory()}
            </section>
          </div>
        ) : null}
      </section>
    </main>
  );
}

export default StudentsCoursesPage;

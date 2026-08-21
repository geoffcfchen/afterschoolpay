import {
  arrayUnion,
  collection,
  doc,
  getDoc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  where,
  writeBatch,
} from "firebase/firestore";
import { DEFAULT_ORG_ID } from "./orgData";
import { realtimeFirestore } from "./realtimeFirestore";

export const PAYROLL_TYPE_LABELS = {
  monthly: "月薪",
  eightLessons: "8堂課",
};

export const SALARY_SLIP_STATUS_LABELS = {
  unpaid: "未發放",
  paid: "已發放",
  void: "作廢",
};

const EIGHT_LESSON_SESSION_COUNT = 8;

const requireFirestore = () => {
  if (!realtimeFirestore) {
    throw new Error("Firebase 尚未設定完成，無法儲存老師薪資。");
  }

  return realtimeFirestore;
};

const toPlainData = (value) => JSON.parse(JSON.stringify(value));

const getEmployeesCollection = (db, orgId) =>
  collection(db, "organizations", orgId, "employees");

const getEmployeeRef = (db, orgId, employeeId) =>
  doc(db, "organizations", orgId, "employees", employeeId);

const getSalarySlipsCollection = (db, orgId, employeeId) =>
  collection(
    db,
    "organizations",
    orgId,
    "employees",
    employeeId,
    "salarySlips",
  );

const normalizeEmployeeName = (name) =>
  String(name || "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, "")
    .toLowerCase();

const createStableId = (prefix) => {
  if (globalThis.crypto?.randomUUID) {
    return `${prefix}-${globalThis.crypto.randomUUID()}`;
  }

  return `${prefix}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
};

const buildBranchSnapshot = (branch) => ({
  id: branch?.id || "",
  name: branch?.name || "",
  shortName: branch?.shortName || "",
});

const parseAmount = (value) => {
  const numberValue = Number(value);

  return Number.isFinite(numberValue) ? numberValue : 0;
};

const sortByName = (records) =>
  [...records].sort((first, second) => {
    const firstName = first.normalizedName || first.name || first.id;
    const secondName = second.normalizedName || second.name || second.id;

    return firstName.localeCompare(secondName, undefined, {
      numeric: true,
      sensitivity: "base",
    });
  });

export function createSalaryClassDraft() {
  return {
    id: createStableId("salary-class"),
    className: "",
    sessions: Array.from({ length: EIGHT_LESSON_SESSION_COUNT }, (_, index) => ({
      id: `session-${index + 1}`,
      date: "",
      hourlyRate: "",
      hours: "",
    })),
  };
}

export function getSalarySlipStatusLabel(status) {
  return SALARY_SLIP_STATUS_LABELS[status] || status || "未發放";
}

export function getPayrollTypeLabel(type) {
  return PAYROLL_TYPE_LABELS[type] || type || "未設定";
}

export function calculateSalarySessionAmount(session) {
  return parseAmount(session?.hourlyRate) * parseAmount(session?.hours);
}

export function calculateSalaryClassTotal(classDraft) {
  return (classDraft?.sessions || []).reduce(
    (total, session) => total + calculateSalarySessionAmount(session),
    0,
  );
}

export function calculateEightLessonTotal(classDrafts = []) {
  return classDrafts.reduce(
    (total, classDraft) => total + calculateSalaryClassTotal(classDraft),
    0,
  );
}

function buildAdditionalSalaryLineItems(additionalSalaryItems = []) {
  return additionalSalaryItems
    .map((item, index) => {
      const amount = parseAmount(item.amount);
      const reason = String(item.reason || "").trim();

      return {
        id: item.id || `additional-salary-${index + 1}`,
        amount,
        description: reason || "未填寫原因",
        name: "額外薪資",
        quantity: 1,
        reason,
        type: "additionalSalary",
      };
    })
    .filter((item) => item.amount !== 0);
}

function buildMonthlySalaryPayload({
  additionalSalaryItems = [],
  monthlyAmount,
  salaryDate,
  salaryMonth,
}) {
  const baseAmount = parseAmount(monthlyAmount);
  const additionalLineItems =
    buildAdditionalSalaryLineItems(additionalSalaryItems);
  const total =
    baseAmount +
    additionalLineItems.reduce((sum, item) => sum + parseAmount(item.amount), 0);

  return {
    classes: [],
    lineItems: [
      {
        id: "monthly-salary",
        amount: baseAmount,
        description: salaryDate || salaryMonth || "未設定日期",
        name: "月薪",
        quantity: 1,
        type: "monthly",
      },
      ...additionalLineItems,
    ],
    additionalSalaryItems: additionalLineItems.map((item) => ({
      amount: item.amount,
      id: item.id,
      reason: item.reason,
    })),
    period: {
      endDate: salaryDate || "",
      month: salaryMonth || "",
      startDate: salaryDate || "",
    },
    total,
  };
}

function buildEightLessonSalaryPayload({
  additionalSalaryItems = [],
  classDrafts = [],
}) {
  const classes = classDrafts
    .map((classDraft, classIndex) => {
      const sessions = (classDraft.sessions || []).map((session, sessionIndex) => {
        const hourlyRate = parseAmount(session.hourlyRate);
        const hours = parseAmount(session.hours);

        return {
          amount: hourlyRate * hours,
          date: session.date || "",
          hourlyRate,
          hours,
          id: session.id || `session-${sessionIndex + 1}`,
          sequence: sessionIndex + 1,
        };
      });
      const total = sessions.reduce((sum, session) => sum + session.amount, 0);
      const totalHours = sessions.reduce((sum, session) => sum + session.hours, 0);

      return {
        className:
          classDraft.className?.trim() || `課程 ${String(classIndex + 1)}`,
        id: classDraft.id || `salary-class-${classIndex + 1}`,
        sessions,
        total,
        totalHours,
      };
    })
    .filter(
      (classRecord) =>
        classRecord.total > 0 ||
        classRecord.sessions.some((session) => session.date),
    );
  const dates = classes
    .flatMap((classRecord) =>
      classRecord.sessions.map((session) => session.date).filter(Boolean),
    )
    .sort();
  const additionalLineItems =
    buildAdditionalSalaryLineItems(additionalSalaryItems);
  const classTotal = classes.reduce((sum, classRecord) => sum + classRecord.total, 0);
  const additionalTotal = additionalLineItems.reduce(
    (sum, item) => sum + parseAmount(item.amount),
    0,
  );

  return {
    additionalSalaryItems: additionalLineItems.map((item) => ({
      amount: item.amount,
      id: item.id,
      reason: item.reason,
    })),
    classes,
    lineItems: [
      ...classes.map((classRecord) => ({
        id: classRecord.id,
        amount: classRecord.total,
        description: `${classRecord.sessions.length} 堂 · ${classRecord.totalHours} 小時`,
        name: classRecord.className,
        quantity: classRecord.totalHours,
        type: "eightLessonsClass",
      })),
      ...additionalLineItems,
    ],
    period: {
      endDate: dates.at(-1) || "",
      month: "",
      startDate: dates[0] || "",
    },
    total: classTotal + additionalTotal,
  };
}

export async function createTeacherEmployee({
  branch,
  compensationType = "monthly",
  createdByUid = "",
  name,
  orgId = DEFAULT_ORG_ID,
}) {
  const cleanName = name.trim();

  if (!cleanName) {
    throw new Error("請輸入老師姓名。");
  }

  if (!branch?.id) {
    throw new Error("請先選擇分校。");
  }

  const db = requireFirestore();
  const employeeRef = doc(getEmployeesCollection(db, orgId));
  const employee = {
    branchIds: [branch.id],
    branches: [buildBranchSnapshot(branch)],
    compensationType:
      compensationType === "eightLessons" ? "eightLessons" : "monthly",
    createdByUid,
    id: employeeRef.id,
    name: cleanName,
    normalizedName: normalizeEmployeeName(cleanName),
    status: "active",
  };

  await setDoc(employeeRef, {
    ...employee,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  return {
    ...employee,
    createdAt: null,
    updatedAt: null,
  };
}

export async function saveTeacherSalarySlip({
  additionalSalaryItems = [],
  branch,
  classDrafts = [],
  employee,
  generatedByEmail = "",
  generatedByUid = "",
  monthlyAmount = 0,
  organization,
  orgId = DEFAULT_ORG_ID,
  payrollType = "monthly",
  salaryDate = "",
  salaryMonth = "",
}) {
  if (!employee?.id || !employee?.name) {
    throw new Error("請先選擇老師。");
  }

  if (!branch?.id) {
    throw new Error("請先選擇分校。");
  }

  const db = requireFirestore();
  const employeeRef = getEmployeeRef(db, orgId, employee.id);
  const employeeSnapshot = await getDoc(employeeRef);
  const salarySlipRef = doc(getSalarySlipsCollection(db, orgId, employee.id));
  const issuedAtIso = new Date().toISOString();
  const salarySlipNumber = `PAY-${issuedAtIso
    .slice(0, 10)
    .replaceAll("-", "")}-${salarySlipRef.id.slice(0, 6).toUpperCase()}`;
  const normalizedPayrollType =
    payrollType === "eightLessons" ? "eightLessons" : "monthly";
  const salaryPayload =
    normalizedPayrollType === "monthly"
      ? buildMonthlySalaryPayload({
          additionalSalaryItems,
          monthlyAmount,
          salaryDate,
          salaryMonth,
        })
      : buildEightLessonSalaryPayload({
          additionalSalaryItems,
          classDrafts,
        });

  if (salaryPayload.total <= 0) {
    throw new Error("薪資單金額必須大於 0。");
  }

  const batch = writeBatch(db);

  batch.set(
    employeeRef,
    {
      branchIds: arrayUnion(branch.id),
      branches: arrayUnion(buildBranchSnapshot(branch)),
      compensationType: normalizedPayrollType,
      createdAt: employeeSnapshot.exists()
        ? employeeSnapshot.data().createdAt
        : serverTimestamp(),
      lastSalarySlipAt: serverTimestamp(),
      name: employee.name,
      normalizedName: normalizeEmployeeName(employee.name),
      status: "active",
      updatedAt: serverTimestamp(),
    },
    { merge: true },
  );

  batch.set(salarySlipRef, {
    balance: salaryPayload.total,
    branchId: branch.id,
    branchSnapshot: buildBranchSnapshot(branch),
    classes: toPlainData(salaryPayload.classes),
    employeeId: employee.id,
    employeeSnapshot: {
      id: employee.id,
      name: employee.name,
    },
    generatedByEmail,
    generatedByUid,
    id: salarySlipRef.id,
    issuedAt: serverTimestamp(),
    issuedAtIso,
    lineItems: toPlainData(salaryPayload.lineItems),
    additionalSalaryItems: toPlainData(
      salaryPayload.additionalSalaryItems || [],
    ),
    organizationSnapshot: {
      id: organization?.id || orgId,
      name: organization?.name || "",
    },
    paidTotal: 0,
    payrollType: normalizedPayrollType,
    period: salaryPayload.period,
    salaryDate,
    salaryMonth,
    salarySlipNumber,
    source: "teacher-payroll",
    status: "unpaid",
    total: salaryPayload.total,
    updatedAt: serverTimestamp(),
  });

  await batch.commit();

  return {
    employeeId: employee.id,
    salarySlipId: salarySlipRef.id,
    salarySlipNumber,
  };
}

export function subscribeOrganizationEmployees({
  branchIds = [],
  canViewAllBranches = false,
  onChange,
  onError,
  orgId = DEFAULT_ORG_ID,
}) {
  const db = requireFirestore();
  const cleanBranchIds = [...new Set(branchIds || [])].filter(Boolean);

  if (!canViewAllBranches && !cleanBranchIds.length) {
    onChange([]);

    return () => {};
  }

  const employeesQuery =
    cleanBranchIds.length && !canViewAllBranches
      ? query(
          getEmployeesCollection(db, orgId),
          where("branchIds", "array-contains-any", cleanBranchIds.slice(0, 10)),
        )
      : getEmployeesCollection(db, orgId);

  return onSnapshot(
    employeesQuery,
    { includeMetadataChanges: true },
    (snapshot) => {
      onChange(
        sortByName(
          snapshot.docs.map((record) => ({
            id: record.id,
            ...record.data(),
            metadata: {
              fromCache: snapshot.metadata?.fromCache || false,
              hasPendingWrites: snapshot.metadata?.hasPendingWrites || false,
            },
          })),
        ),
      );
    },
    (error) => {
      if (onError) {
        onError(error);
      }
    },
  );
}

export function subscribeEmployeeSalarySlips({
  employeeId = "",
  onChange,
  onError,
  orgId = DEFAULT_ORG_ID,
}) {
  if (!employeeId) {
    return () => {};
  }

  const db = requireFirestore();
  const salarySlipQuery = query(
    getSalarySlipsCollection(db, orgId, employeeId),
    orderBy("issuedAtIso", "desc"),
  );

  return onSnapshot(
    salarySlipQuery,
    { includeMetadataChanges: true },
    (snapshot) => {
      onChange(
        snapshot.docs.map((record) => ({
          id: record.id,
          ...record.data(),
          metadata: {
            fromCache: snapshot.metadata?.fromCache || false,
            hasPendingWrites: snapshot.metadata?.hasPendingWrites || false,
          },
        })),
      );
    },
    (error) => {
      if (onError) {
        onError(error);
      }
    },
  );
}

export async function updateTeacherSalarySlipStatus({
  employeeId,
  orgId = DEFAULT_ORG_ID,
  salarySlipId,
  status,
  total = 0,
  updatedByUid = "",
}) {
  if (!employeeId || !salarySlipId || !status) {
    throw new Error("缺少薪資單或狀態資料。");
  }

  const db = requireFirestore();
  const normalizedTotal = parseAmount(total);
  const statusChangedAtIso = new Date().toISOString();
  const paymentFields =
    status === "paid"
      ? {
          balance: 0,
          paidAt: serverTimestamp(),
          paidAtIso: statusChangedAtIso,
          paidTotal: normalizedTotal,
        }
      : status === "void"
        ? {
            balance: 0,
            paidTotal: 0,
            voidedAt: serverTimestamp(),
            voidedAtIso: statusChangedAtIso,
          }
        : {
            balance: normalizedTotal,
            paidAt: null,
            paidAtIso: null,
            paidTotal: 0,
            voidedAt: null,
            voidedAtIso: null,
          };

  await setDoc(
    doc(getSalarySlipsCollection(db, orgId, employeeId), salarySlipId),
    {
      ...paymentFields,
      status,
      statusUpdatedByUid: updatedByUid,
      updatedAt: serverTimestamp(),
    },
    { merge: true },
  );
}

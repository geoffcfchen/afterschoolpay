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
import { realtimeFirestore } from "./realtimeFirestore";
import { DEFAULT_ORG_ID } from "./orgData";

export const INVOICE_STATUS_LABELS = {
  unpaid: "未付款",
  overdue: "已逾期",
  paid: "已付款",
  void: "作廢",
};

const requireFirestore = () => {
  if (!realtimeFirestore) {
    throw new Error("Firebase 尚未設定完成，無法儲存繳費通知單。");
  }

  return realtimeFirestore;
};

const toPlainData = (value) => JSON.parse(JSON.stringify(value));

export function getInvoiceStatusLabel(status) {
  return INVOICE_STATUS_LABELS[status] || status || "未付款";
}

export function createStudentAccountId() {
  if (globalThis.crypto?.randomUUID) {
    return `student-${globalThis.crypto.randomUUID()}`;
  }

  return `student-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

export function normalizeStudentName(name) {
  return String(name || "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, "")
    .toLowerCase();
}

function getStudentRef(db, orgId, studentId) {
  return doc(db, "organizations", orgId, "students", studentId);
}

function getStudentInvoicesCollection(db, orgId, studentId) {
  return collection(
    db,
    "organizations",
    orgId,
    "students",
    studentId,
    "invoices",
  );
}

function getStudentsCollection(db, orgId) {
  return collection(db, "organizations", orgId, "students");
}

function buildBranchClassSnapshot(branch, classSheet) {
  return {
    branchId: branch?.id || "",
    branchName: branch?.name || "",
    branchShortName: branch?.shortName || "",
    classId: classSheet?.id || "",
    className: classSheet?.name || "",
  };
}

function buildStudentAccountsFromClassSheets(classSheets = [], branch) {
  const accounts = new Map();

  classSheets.forEach((classSheet) => {
    (classSheet.studentRows || []).forEach((row) => {
      if (!row.studentId || !row.studentName) {
        return;
      }

      const account = accounts.get(row.studentId) || {
        branchClassKeys: new Set(),
        branchClasses: new Map(),
        branchIds: new Set(),
        classIds: new Set(),
        classNames: new Set(),
        legacyStudentNumbers: new Set(),
        name: row.studentName,
        normalizedName: normalizeStudentName(row.studentName),
        studentId: row.studentId,
      };

      if (branch?.id) {
        account.branchIds.add(branch.id);
        account.branchClassKeys.add(`${branch.id}:${classSheet.id}`);
        account.branchClasses.set(
          `${branch.id}:${classSheet.id}`,
          buildBranchClassSnapshot(branch, classSheet),
        );
      }

      if (classSheet.id) {
        account.classIds.add(classSheet.id);
      }

      if (classSheet.name) {
        account.classNames.add(classSheet.name);
      }

      if (row.studentNumber) {
        account.legacyStudentNumbers.add(row.studentNumber);
      }

      accounts.set(row.studentId, account);
    });
  });

  return [...accounts.values()].map((account) => ({
    branchClassKeys: [...account.branchClassKeys],
    branchClasses: [...account.branchClasses.values()],
    branchIds: [...account.branchIds],
    classIds: [...account.classIds],
    classNames: [...account.classNames],
    legacyStudentNumbers: [...account.legacyStudentNumbers],
    name: account.name,
    normalizedName: account.normalizedName,
    studentId: account.studentId,
  }));
}

function addArrayUnionField(data, key, values) {
  const cleanValues = [...new Set(values || [])].filter(Boolean);

  if (cleanValues.length) {
    data[key] = arrayUnion(...cleanValues);
  }
}

function buildInvoiceLineItems(invoice) {
  return [
    ...(invoice.courseLines || []).map((line) => ({
      id: line.id,
      type: "course",
      name: line.label,
      subjectCode: line.subjectCode || "",
      dates: line.dates || [],
      quantity: line.sessionCount || 0,
      amount: line.amount || 0,
    })),
    ...(invoice.feeLines || []).map((line) => ({
      id: line.id,
      type: "fee",
      code: line.code || "",
      name: line.label,
      description: line.details || "",
      amount: line.amount || 0,
    })),
    ...(invoice.customFeeLines || []).map((line) => ({
      id: line.id,
      type: "customFee",
      name: line.name,
      description: "自訂雜項",
      amount: line.amount || 0,
    })),
  ];
}

function getBillingPeriod(invoice) {
  const dates = (invoice.courseLines || [])
    .flatMap((line) => line.dates || [])
    .filter(Boolean)
    .sort();

  return {
    endDate: dates.at(-1) || "",
    startDate: dates[0] || "",
  };
}

export async function syncStudentAccountsFromClassSheets({
  branch,
  classSheets = [],
  orgId = DEFAULT_ORG_ID,
  savedByUid = "",
}) {
  if (!branch?.id) {
    return { count: 0 };
  }

  const db = requireFirestore();
  const accounts = buildStudentAccountsFromClassSheets(classSheets, branch);
  const accountSnapshots = await Promise.all(
    accounts.map((account) => getDoc(getStudentRef(db, orgId, account.studentId))),
  );
  const chunkSize = 450;

  for (let index = 0; index < accounts.length; index += chunkSize) {
    const batch = writeBatch(db);
    const chunk = accounts.slice(index, index + chunkSize);

    chunk.forEach((account, chunkIndex) => {
      const snapshot = accountSnapshots[index + chunkIndex];
      const studentData = {
        importedByUid: savedByUid || "",
        name: account.name,
        normalizedName: account.normalizedName,
        status: "active",
        studentId: account.studentId,
        updatedAt: serverTimestamp(),
      };

      if (!snapshot.exists()) {
        studentData.createdAt = serverTimestamp();
      }

      addArrayUnionField(studentData, "branchClassKeys", account.branchClassKeys);
      addArrayUnionField(studentData, "branchClasses", account.branchClasses);
      addArrayUnionField(studentData, "branchIds", account.branchIds);
      addArrayUnionField(studentData, "classIds", account.classIds);
      addArrayUnionField(studentData, "classNames", account.classNames);
      addArrayUnionField(
        studentData,
        "legacyStudentNumbers",
        account.legacyStudentNumbers,
      );

      batch.set(getStudentRef(db, orgId, account.studentId), studentData, {
        merge: true,
      });
    });

    await batch.commit();
  }

  return {
    count: accounts.length,
  };
}

export async function saveStudentInvoiceNotice({
  branch,
  classSheet,
  generatedByEmail = "",
  generatedByUid = "",
  invoice,
  organization,
  orgId = DEFAULT_ORG_ID,
  studentRow,
}) {
  if (
    !studentRow?.studentId ||
    !studentRow?.studentName ||
    !classSheet?.id ||
    !branch?.id
  ) {
    throw new Error("缺少學生、班級或分校資料，無法產生繳費通知單。");
  }

  const db = requireFirestore();
  const studentId = studentRow.studentId;
  const studentRef = getStudentRef(db, orgId, studentId);
  const studentSnapshot = await getDoc(studentRef);
  const invoiceRef = doc(getStudentInvoicesCollection(db, orgId, studentId));
  const issuedAtIso = new Date().toISOString();
  const invoiceNumber = `NOTICE-${issuedAtIso.slice(0, 10).replaceAll("-", "")}-${invoiceRef.id
    .slice(0, 6)
    .toUpperCase()}`;
  const lineItems = buildInvoiceLineItems(invoice);
  const billingPeriod = getBillingPeriod(invoice);
  const batch = writeBatch(db);
  const total = Number(invoice.total) || 0;

  batch.set(
    studentRef,
    {
      branchClassKeys: arrayUnion(`${branch.id}:${classSheet.id}`),
      branchClasses: arrayUnion(buildBranchClassSnapshot(branch, classSheet)),
      branchIds: arrayUnion(branch.id),
      classIds: arrayUnion(classSheet.id),
      createdAt: studentSnapshot.exists()
        ? studentSnapshot.data().createdAt
        : serverTimestamp(),
      lastInvoiceAt: serverTimestamp(),
      legacyStudentNumbers: arrayUnion(studentRow.studentNumber || ""),
      name: studentRow.studentName,
      normalizedName: normalizeStudentName(studentRow.studentName),
      status: "active",
      studentId,
      updatedAt: serverTimestamp(),
    },
    { merge: true },
  );

  batch.set(invoiceRef, {
    balance: total,
    billingPeriod,
    classId: classSheet.id,
    className: classSheet.name,
    classSnapshot: {
      id: classSheet.id,
      name: classSheet.name,
      courseLabels: classSheet.courseLabels || [],
    },
    generatedByEmail,
    generatedByUid,
    id: invoiceRef.id,
    invoiceNumber,
    issuedAt: serverTimestamp(),
    issuedAtIso,
    lineItems: toPlainData(lineItems),
    organizationSnapshot: {
      id: organization?.id || orgId,
      name: organization?.name || "",
    },
    paidTotal: 0,
    source: "students-courses",
    sourceBranchId: branch.id,
    sourceBranchSnapshot: {
      id: branch.id,
      name: branch.name || "",
      shortName: branch.shortName || "",
    },
    sourceRowId: studentRow.id,
    status: "unpaid",
    studentId,
    studentSnapshot: {
      id: studentId,
      name: studentRow.studentName,
      studentNumber: studentRow.studentNumber || "",
    },
    total,
    updatedAt: serverTimestamp(),
  });

  await batch.commit();

  return {
    invoiceId: invoiceRef.id,
    invoiceNumber,
    studentId,
  };
}

export function subscribeStudentInvoices({
  onChange,
  onError,
  orgId = DEFAULT_ORG_ID,
  studentId = "",
}) {
  if (!studentId) {
    return () => {};
  }

  const db = requireFirestore();
  const invoiceQuery = query(
    getStudentInvoicesCollection(db, orgId, studentId),
    orderBy("issuedAtIso", "desc"),
  );

  return onSnapshot(
    invoiceQuery,
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

export function subscribeOrganizationStudents({
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

  const studentsQuery =
    cleanBranchIds.length && !canViewAllBranches
      ? query(
          getStudentsCollection(db, orgId),
          where("branchIds", "array-contains-any", cleanBranchIds.slice(0, 10)),
        )
      : getStudentsCollection(db, orgId);

  return onSnapshot(
    studentsQuery,
    { includeMetadataChanges: true },
    (snapshot) => {
      const records = snapshot.docs
        .map((record) => ({
          id: record.id,
          ...record.data(),
          metadata: {
            fromCache: snapshot.metadata?.fromCache || false,
            hasPendingWrites: snapshot.metadata?.hasPendingWrites || false,
          },
        }))
        .sort((first, second) => {
          const firstName =
            first.normalizedName || first.name || first.studentId || first.id;
          const secondName =
            second.normalizedName || second.name || second.studentId || second.id;

          return firstName.localeCompare(secondName);
        });

      onChange(records);
    },
    (error) => {
      if (onError) {
        onError(error);
      }
    },
  );
}

export async function updateStudentInvoiceStatus({
  invoiceId,
  orgId = DEFAULT_ORG_ID,
  status,
  studentId,
  total = 0,
  updatedByUid = "",
}) {
  if (!studentId || !invoiceId || !status) {
    throw new Error("缺少通知單或狀態資料。");
  }

  const db = requireFirestore();
  const normalizedTotal = Number(total) || 0;
  const paymentFields =
    status === "paid"
      ? {
          balance: 0,
          paidAt: serverTimestamp(),
          paidTotal: normalizedTotal,
        }
      : status === "void"
        ? {
            balance: 0,
            voidedAt: serverTimestamp(),
          }
        : {
            balance: normalizedTotal,
            paidAt: null,
            paidTotal: 0,
            voidedAt: null,
          };

  await setDoc(
    doc(getStudentInvoicesCollection(db, orgId, studentId), invoiceId),
    {
      ...paymentFields,
      status,
      statusUpdatedByUid: updatedByUid,
      updatedAt: serverTimestamp(),
    },
    { merge: true },
  );
}

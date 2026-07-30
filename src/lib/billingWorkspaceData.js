import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  serverTimestamp,
  writeBatch,
} from "firebase/firestore/lite";
import { firestore } from "./firebase";
import { DEFAULT_ORG_ID } from "./orgData";

const CURRENT_WORKSPACE_ID = "current";
const WORKSPACE_VERSION = 1;

const requireFirestore = () => {
  if (!firestore) {
    throw new Error("Firebase 尚未設定完成，無法儲存收費工作台。");
  }

  return firestore;
};

const toPlainData = (value) => JSON.parse(JSON.stringify(value));

const workspacePath = (orgId = DEFAULT_ORG_ID, branchId = "") =>
  branchId
    ? [
        "organizations",
        orgId,
        "branches",
        branchId,
        "billingWorkspaces",
        CURRENT_WORKSPACE_ID,
      ]
    : ["organizations", orgId, "billingWorkspaces", CURRENT_WORKSPACE_ID];

const classesPath = (orgId = DEFAULT_ORG_ID, branchId = "") => [
  ...workspacePath(orgId, branchId),
  "classes",
];

function getWorkspaceRef(db, orgId, branchId) {
  return doc(db, ...workspacePath(orgId, branchId));
}

function getClassesCollection(db, orgId, branchId) {
  return collection(db, ...classesPath(orgId, branchId));
}

function makeClassDocId(index) {
  return `class-${String(index + 1).padStart(2, "0")}`;
}

export async function saveCurrentBillingWorkspace({
  activeClassId,
  branchId = "",
  dismissedDoubleCourseRows,
  feeOptions,
  invoiceState,
  orgId = DEFAULT_ORG_ID,
  result,
  savedByUid,
  selectedInvoiceRowId,
}) {
  const db = requireFirestore();
  const workspaceRef = getWorkspaceRef(db, orgId, branchId);
  const classCollection = getClassesCollection(db, orgId, branchId);
  const [workspaceSnapshot, classSnapshot] = await Promise.all([
    getDoc(workspaceRef),
    getDocs(classCollection),
  ]);
  const batch = writeBatch(db);
  const classRecords = result.classSheets.map((sheet, index) => ({
    id: makeClassDocId(index),
    order: index,
    sheet,
    draft: invoiceState.classes[sheet.id],
  }));
  const nextClassIds = new Set(classRecords.map((record) => record.id));

  batch.set(workspaceRef, {
    version: WORKSPACE_VERSION,
    fileName: result.fileName,
    fileSize: result.fileSize,
    detectedAt: result.detectedAt,
    summary: toPlainData(result.summary),
    printSheets: toPlainData(result.printSheets || []),
    ignoredSheets: toPlainData(result.ignoredSheets || []),
    feeItems: toPlainData(result.feeItems || []),
    feeOptions: toPlainData(feeOptions || []),
    activeClassId: activeClassId || "",
    branchId,
    selectedInvoiceRowId: selectedInvoiceRowId || "",
    dismissedDoubleCourseRows: toPlainData(dismissedDoubleCourseRows || []),
    savedByUid: savedByUid || "",
    createdAt: workspaceSnapshot.exists()
      ? workspaceSnapshot.data().createdAt
      : serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  classRecords.forEach((record) => {
    batch.set(doc(classCollection, record.id), {
      order: record.order,
      sheet: toPlainData(record.sheet),
      draft: toPlainData(record.draft),
      updatedAt: serverTimestamp(),
    });
  });

  classSnapshot.docs.forEach((record) => {
    if (!nextClassIds.has(record.id)) {
      batch.delete(record.ref);
    }
  });

  await batch.commit();

  return {
    id: CURRENT_WORKSPACE_ID,
    fileName: result.fileName,
    savedByUid: savedByUid || "",
  };
}

async function readCurrentBillingWorkspace(orgId = DEFAULT_ORG_ID, branchId = "") {
  const db = requireFirestore();
  const workspaceRef = getWorkspaceRef(db, orgId, branchId);
  const workspaceSnapshot = await getDoc(workspaceRef);

  if (!workspaceSnapshot.exists()) {
    return null;
  }

  const workspace = workspaceSnapshot.data();
  const classSnapshot = await getDocs(getClassesCollection(db, orgId, branchId));
  const classRecords = classSnapshot.docs
    .map((record) => ({
      id: record.id,
      ...record.data(),
    }))
    .filter((record) => record.sheet?.id)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  if (!classRecords.length) {
    return null;
  }

  const classSheets = classRecords.map((record) => record.sheet);

  return {
    id: CURRENT_WORKSPACE_ID,
    activeClassId: workspace.activeClassId || classSheets[0]?.id || "",
    branchId: workspace.branchId || branchId,
    dismissedDoubleCourseRows: workspace.dismissedDoubleCourseRows || [],
    feeOptions: workspace.feeOptions || workspace.feeItems || [],
    invoiceState: {
      classes: Object.fromEntries(
        classRecords.map((record) => [record.sheet.id, record.draft]),
      ),
    },
    result: {
      fileName: workspace.fileName || "已儲存的收費資料",
      fileSize: workspace.fileSize || 0,
      detectedAt: workspace.detectedAt || "",
      summary: workspace.summary || {
        totalSheets: classSheets.length,
        classSheetCount: classSheets.length,
        printSheetCount: 0,
        ignoredSheetCount: 0,
        studentCount: 0,
        enrollmentCount: 0,
        sessionCount: 0,
        feeItemCount: workspace.feeItems?.length || 0,
        feeDraftCount: 0,
        receivableDraftCount: 0,
      },
      classSheets,
      printSheets: workspace.printSheets || [],
      ignoredSheets: workspace.ignoredSheets || [],
      students: [],
      enrollments: [],
      sessions: [],
      feeItems: workspace.feeItems || [],
      feeDrafts: [],
      receivableDrafts: [],
    },
    selectedInvoiceRowId: workspace.selectedInvoiceRowId || "",
    savedByUid: workspace.savedByUid || "",
    updatedAt: workspace.updatedAt || null,
  };
}

export async function loadCurrentBillingWorkspace(
  orgId = DEFAULT_ORG_ID,
  branchId = "",
  { fallbackToOrganizationWorkspace = false } = {},
) {
  const branchWorkspace = await readCurrentBillingWorkspace(orgId, branchId);

  if (branchWorkspace || !branchId || !fallbackToOrganizationWorkspace) {
    return branchWorkspace;
  }

  const legacyWorkspace = await readCurrentBillingWorkspace(orgId, "");

  return legacyWorkspace
    ? {
        ...legacyWorkspace,
        branchId,
        legacyOrganizationWorkspace: true,
      }
    : null;
}

export async function clearCurrentBillingWorkspace(
  orgId = DEFAULT_ORG_ID,
  branchId = "",
) {
  const db = requireFirestore();
  const workspaceRef = getWorkspaceRef(db, orgId, branchId);
  const classSnapshot = await getDocs(getClassesCollection(db, orgId, branchId));

  await Promise.all([
    ...classSnapshot.docs.map((record) => deleteDoc(record.ref)),
    deleteDoc(workspaceRef),
  ]);
}

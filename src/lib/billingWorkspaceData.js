import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  writeBatch,
} from "firebase/firestore";
import { realtimeFirestore } from "./realtimeFirestore";
import { DEFAULT_ORG_ID } from "./orgData";

const CURRENT_WORKSPACE_ID = "current";
const FEE_OPTIONS_SETTINGS_ID = "feeOptions";
const WORKSPACE_VERSION = 1;

const requireFirestore = () => {
  if (!realtimeFirestore) {
    throw new Error("Firebase 尚未設定完成，無法儲存收費工作台。");
  }

  return realtimeFirestore;
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

const branchFeeOptionsPath = (orgId = DEFAULT_ORG_ID, branchId = "") => [
  "organizations",
  orgId,
  "branches",
  branchId,
  "settings",
  FEE_OPTIONS_SETTINGS_ID,
];

function getWorkspaceRef(db, orgId, branchId) {
  return doc(db, ...workspacePath(orgId, branchId));
}

function getClassesCollection(db, orgId, branchId) {
  return collection(db, ...classesPath(orgId, branchId));
}

function getBranchFeeOptionsRef(db, orgId, branchId) {
  return doc(db, ...branchFeeOptionsPath(orgId, branchId));
}

function makeClassDocId(index) {
  return `class-${String(index + 1).padStart(2, "0")}`;
}

function buildBranchFeeOptions(snapshot) {
  const data = snapshot.exists() ? snapshot.data() : {};

  return {
    exists: snapshot.exists(),
    feeOptions: data.feeOptions || [],
    metadata: {
      fromCache: snapshot.metadata?.fromCache || false,
      hasPendingWrites: snapshot.metadata?.hasPendingWrites || false,
    },
    savedByClientId: data.savedByClientId || "",
    savedByUid: data.savedByUid || "",
    updatedAt: data.updatedAt || null,
  };
}

function buildCurrentBillingWorkspace({
  branchId,
  classSnapshot,
  workspaceSnapshot,
}) {
  if (!workspaceSnapshot.exists()) {
    return null;
  }

  const workspace = workspaceSnapshot.data();
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
    clientSaveVersion: workspace.clientSaveVersion || 0,
    dismissedDoubleCourseRows: workspace.dismissedDoubleCourseRows || [],
    feeOptions: workspace.feeOptions || workspace.feeItems || [],
    invoiceState: {
      classes: Object.fromEntries(
        classRecords.map((record) => [record.sheet.id, record.draft]),
      ),
    },
    metadata: {
      fromCache:
        workspaceSnapshot.metadata?.fromCache ||
        classSnapshot.metadata?.fromCache ||
        false,
      hasPendingWrites:
        workspaceSnapshot.metadata?.hasPendingWrites ||
        classSnapshot.metadata?.hasPendingWrites ||
        false,
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
    savedByClientId: workspace.savedByClientId || "",
    savedByUid: workspace.savedByUid || "",
    selectedInvoiceRowId: workspace.selectedInvoiceRowId || "",
    updatedAt: workspace.updatedAt || null,
  };
}

function subscribeWorkspaceRecord({ branchId = "", onChange, onError, orgId }) {
  const db = requireFirestore();
  const workspaceRef = getWorkspaceRef(db, orgId, branchId);
  const classQuery = query(
    getClassesCollection(db, orgId, branchId),
    orderBy("order"),
  );
  let workspaceSnapshot = null;
  let classSnapshot = null;
  let workspaceReady = false;
  let classesReady = false;

  const emitIfReady = () => {
    if (!workspaceReady || !classesReady) {
      return;
    }

    onChange(
      buildCurrentBillingWorkspace({
        branchId,
        classSnapshot,
        workspaceSnapshot,
      }),
    );
  };

  const handleError = (error) => {
    if (onError) {
      onError(error);
    }
  };

  const unsubscribeWorkspace = onSnapshot(
    workspaceRef,
    { includeMetadataChanges: true },
    (snapshot) => {
      workspaceSnapshot = snapshot;
      workspaceReady = true;
      emitIfReady();
    },
    handleError,
  );
  const unsubscribeClasses = onSnapshot(
    classQuery,
    { includeMetadataChanges: true },
    (snapshot) => {
      classSnapshot = snapshot;
      classesReady = true;
      emitIfReady();
    },
    handleError,
  );

  return () => {
    unsubscribeWorkspace();
    unsubscribeClasses();
  };
}

export async function saveCurrentBillingWorkspace({
  activeClassId,
  branchId = "",
  clientSaveVersion = 0,
  dismissedDoubleCourseRows,
  feeOptions,
  invoiceState,
  orgId = DEFAULT_ORG_ID,
  result,
  savedByClientId = "",
  savedByUid,
  selectedInvoiceRowId,
}) {
  const db = requireFirestore();
  const workspaceRef = getWorkspaceRef(db, orgId, branchId);
  const classCollection = getClassesCollection(db, orgId, branchId);
  const branchFeeOptionsRef = branchId
    ? getBranchFeeOptionsRef(db, orgId, branchId)
    : null;
  const [workspaceSnapshot, classSnapshot, branchFeeOptionsSnapshot] =
    await Promise.all([
      getDoc(workspaceRef),
      getDocs(classCollection),
      branchFeeOptionsRef ? getDoc(branchFeeOptionsRef) : Promise.resolve(null),
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
    clientSaveVersion,
    selectedInvoiceRowId: selectedInvoiceRowId || "",
    dismissedDoubleCourseRows: toPlainData(dismissedDoubleCourseRows || []),
    savedByClientId,
    savedByUid: savedByUid || "",
    createdAt: workspaceSnapshot.exists()
      ? workspaceSnapshot.data().createdAt
      : serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  if (branchFeeOptionsRef) {
    batch.set(branchFeeOptionsRef, {
      branchId,
      feeOptions: toPlainData(feeOptions || []),
      savedByClientId,
      savedByUid: savedByUid || "",
      createdAt: branchFeeOptionsSnapshot?.exists()
        ? branchFeeOptionsSnapshot.data().createdAt
        : serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  }

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
    clientSaveVersion,
    fileName: result.fileName,
    savedByClientId,
    savedByUid: savedByUid || "",
  };
}

export async function saveBranchFeeOptions({
  branchId = "",
  feeOptions,
  orgId = DEFAULT_ORG_ID,
  savedByClientId = "",
  savedByUid = "",
}) {
  if (!branchId) {
    throw new Error("缺少分校，無法儲存雜項表。");
  }

  const db = requireFirestore();
  const feeOptionsRef = getBranchFeeOptionsRef(db, orgId, branchId);
  const feeOptionsSnapshot = await getDoc(feeOptionsRef);

  await setDoc(feeOptionsRef, {
    branchId,
    feeOptions: toPlainData(feeOptions || []),
    savedByClientId,
    savedByUid: savedByUid || "",
    createdAt: feeOptionsSnapshot.exists()
      ? feeOptionsSnapshot.data().createdAt
      : serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  return {
    branchId,
    savedByClientId,
    savedByUid,
  };
}

export function subscribeBranchFeeOptions({
  branchId = "",
  onChange,
  onError,
  orgId = DEFAULT_ORG_ID,
}) {
  if (!branchId) {
    return () => {};
  }

  const db = requireFirestore();

  return onSnapshot(
    getBranchFeeOptionsRef(db, orgId, branchId),
    { includeMetadataChanges: true },
    (snapshot) => onChange(buildBranchFeeOptions(snapshot)),
    (error) => {
      if (onError) {
        onError(error);
      }
    },
  );
}

async function readCurrentBillingWorkspace(orgId = DEFAULT_ORG_ID, branchId = "") {
  const db = requireFirestore();
  const workspaceRef = getWorkspaceRef(db, orgId, branchId);
  const workspaceSnapshot = await getDoc(workspaceRef);

  const classSnapshot = await getDocs(getClassesCollection(db, orgId, branchId));

  return buildCurrentBillingWorkspace({
    branchId,
    classSnapshot,
    workspaceSnapshot,
  });
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

export function subscribeCurrentBillingWorkspace({
  branchId = "",
  fallbackToOrganizationWorkspace = false,
  onChange,
  onError,
  orgId = DEFAULT_ORG_ID,
}) {
  let unsubscribeLegacy = null;
  const stopLegacy = () => {
    if (unsubscribeLegacy) {
      unsubscribeLegacy();
      unsubscribeLegacy = null;
    }
  };

  const unsubscribeBranch = subscribeWorkspaceRecord({
    branchId,
    onChange: (workspace) => {
      if (workspace || !branchId || !fallbackToOrganizationWorkspace) {
        stopLegacy();
        onChange(workspace);
        return;
      }

      if (!unsubscribeLegacy) {
        unsubscribeLegacy = subscribeWorkspaceRecord({
          branchId: "",
          onChange: (legacyWorkspace) => {
            onChange(
              legacyWorkspace
                ? {
                    ...legacyWorkspace,
                    branchId,
                    legacyOrganizationWorkspace: true,
                  }
                : null,
            );
          },
          onError,
          orgId,
        });
      }
    },
    onError,
    orgId,
  });

  return () => {
    unsubscribeBranch();
    stopLegacy();
  };
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

import {
  collection,
  doc,
  getDoc,
  getDocs,
  serverTimestamp,
  writeBatch,
} from "firebase/firestore";
import { DEFAULT_ORG_ID } from "./orgData";
import { realtimeFirestore } from "./realtimeFirestore";
import { normalizeStudentName } from "./studentInvoiceData";

const BATCH_LIMIT = 400;
const CURRENT_WORKSPACE_ID = "current";

const requireFirestore = () => {
  if (!realtimeFirestore) {
    throw new Error("Firebase 尚未設定完成，無法合併學生資料。");
  }

  return realtimeFirestore;
};

const toPlainData = (value) => JSON.parse(JSON.stringify(value));

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

function getStudentPaymentsCollection(db, orgId, studentId) {
  return collection(
    db,
    "organizations",
    orgId,
    "students",
    studentId,
    "payments",
  );
}

function getWorkspaceClassesCollection(db, orgId, branchId = "") {
  if (!branchId) {
    return collection(
      db,
      "organizations",
      orgId,
      "billingWorkspaces",
      CURRENT_WORKSPACE_ID,
      "classes",
    );
  }

  return collection(
    db,
    "organizations",
    orgId,
    "branches",
    branchId,
    "billingWorkspaces",
    CURRENT_WORKSPACE_ID,
    "classes",
  );
}

function uniqueValues(...lists) {
  return [
    ...new Set(
      lists.flatMap((list) => (Array.isArray(list) ? list : [])).filter(Boolean),
    ),
  ];
}

function uniqueObjects(...lists) {
  const records = new Map();

  lists
    .flatMap((list) => (Array.isArray(list) ? list : []))
    .filter(Boolean)
    .forEach((record) => {
      records.set(JSON.stringify(record), record);
    });

  return [...records.values()];
}

async function chooseTargetDoc(collectionRef, preferredId, prefix) {
  const preferredRef = doc(collectionRef, preferredId);
  const preferredSnapshot = await getDoc(preferredRef);

  if (!preferredSnapshot.exists()) {
    return {
      id: preferredId,
      ref: preferredRef,
    };
  }

  for (let index = 1; index < 20; index += 1) {
    const fallbackId = `${prefix}-${index}-${preferredId}`;
    const fallbackRef = doc(collectionRef, fallbackId);
    const fallbackSnapshot = await getDoc(fallbackRef);

    if (!fallbackSnapshot.exists()) {
      return {
        id: fallbackId,
        ref: fallbackRef,
      };
    }
  }

  const generatedRef = doc(collectionRef);

  return {
    id: generatedRef.id,
    ref: generatedRef,
  };
}

async function commitOperations(db, operations) {
  for (let index = 0; index < operations.length; index += BATCH_LIMIT) {
    const batch = writeBatch(db);
    const chunk = operations.slice(index, index + BATCH_LIMIT);

    chunk.forEach((operation) => {
      if (operation.type === "delete") {
        batch.delete(operation.ref);
        return;
      }

      batch.set(operation.ref, operation.data, operation.options || {});
    });

    await batch.commit();
  }
}

async function updateBillingWorkspaceStudentIds({
  canonicalStudentId,
  duplicateStudentIds,
  db,
  branchIds,
  operations,
  orgId,
}) {
  const duplicateIdSet = new Set(duplicateStudentIds);
  const workspaceBranchIds = ["", ...branchIds];

  await Promise.all(
    workspaceBranchIds.map(async (branchId) => {
      const classSnapshot = await getDocs(
        getWorkspaceClassesCollection(db, orgId, branchId),
      );

      classSnapshot.docs.forEach((classRecord) => {
        const classData = classRecord.data();
        const sheet = classData.sheet || {};
        const studentRows = Array.isArray(sheet.studentRows)
          ? sheet.studentRows
          : [];
        let changed = false;
        const nextRows = studentRows.map((row) => {
          if (!duplicateIdSet.has(row.studentId)) {
            return row;
          }

          changed = true;

          return {
            ...row,
            studentId: canonicalStudentId,
          };
        });

        if (!changed) {
          return;
        }

        operations.push({
          data: {
            sheet: toPlainData({
              ...sheet,
              studentRows: nextRows,
            }),
            updatedAt: serverTimestamp(),
          },
          options: { merge: true },
          ref: classRecord.ref,
          type: "set",
        });
      });
    }),
  );
}

async function moveStudentSubcollections({
  canonicalStudent,
  canonicalStudentId,
  db,
  duplicateStudentIds,
  operations,
  orgId,
}) {
  const canonicalName = canonicalStudent.name || "";

  for (const duplicateStudentId of duplicateStudentIds) {
    const sourceInvoiceCollection = getStudentInvoicesCollection(
      db,
      orgId,
      duplicateStudentId,
    );
    const sourcePaymentCollection = getStudentPaymentsCollection(
      db,
      orgId,
      duplicateStudentId,
    );
    const targetInvoiceCollection = getStudentInvoicesCollection(
      db,
      orgId,
      canonicalStudentId,
    );
    const targetPaymentCollection = getStudentPaymentsCollection(
      db,
      orgId,
      canonicalStudentId,
    );
    const [invoiceSnapshot, paymentSnapshot] = await Promise.all([
      getDocs(sourceInvoiceCollection),
      getDocs(sourcePaymentCollection),
    ]);
    const invoiceTargets = new Map();
    const paymentTargets = new Map();

    for (const invoiceRecord of invoiceSnapshot.docs) {
      const target = await chooseTargetDoc(
        targetInvoiceCollection,
        invoiceRecord.id,
        duplicateStudentId,
      );
      invoiceTargets.set(invoiceRecord.id, target);
    }

    for (const paymentRecord of paymentSnapshot.docs) {
      const target = await chooseTargetDoc(
        targetPaymentCollection,
        paymentRecord.id,
        duplicateStudentId,
      );
      paymentTargets.set(paymentRecord.id, target);
    }

    invoiceSnapshot.docs.forEach((invoiceRecord) => {
      const invoiceData = invoiceRecord.data();
      const target = invoiceTargets.get(invoiceRecord.id);
      const paymentIds = uniqueValues(
        (invoiceData.paymentIds || []).map(
          (paymentId) => paymentTargets.get(paymentId)?.id || paymentId,
        ),
      );

      operations.push({
        data: {
          ...toPlainData(invoiceData),
          id: target.id,
          mergedFromStudentId: duplicateStudentId,
          originalInvoiceId: invoiceData.id || invoiceRecord.id,
          paymentIds,
          studentId: canonicalStudentId,
          studentSnapshot: {
            ...(invoiceData.studentSnapshot || {}),
            id: canonicalStudentId,
            name: canonicalName || invoiceData.studentSnapshot?.name || "",
          },
          updatedAt: serverTimestamp(),
        },
        options: { merge: true },
        ref: target.ref,
        type: "set",
      });
    });

    paymentSnapshot.docs.forEach((paymentRecord) => {
      const paymentData = paymentRecord.data();
      const target = paymentTargets.get(paymentRecord.id);
      const nextInvoiceId =
        invoiceTargets.get(paymentData.invoiceId)?.id || paymentData.invoiceId || "";

      operations.push({
        data: {
          ...toPlainData(paymentData),
          id: target.id,
          invoiceId: nextInvoiceId,
          mergedFromStudentId: duplicateStudentId,
          originalPaymentId: paymentData.id || paymentRecord.id,
          studentId: canonicalStudentId,
          studentSnapshot: {
            ...(paymentData.studentSnapshot || {}),
            id: canonicalStudentId,
            name: canonicalName || paymentData.studentSnapshot?.name || "",
          },
          updatedAt: serverTimestamp(),
        },
        options: { merge: true },
        ref: target.ref,
        type: "set",
      });
    });

    paymentSnapshot.docs.forEach((paymentRecord) => {
      operations.push({
        ref: paymentRecord.ref,
        type: "delete",
      });
    });
    invoiceSnapshot.docs.forEach((invoiceRecord) => {
      operations.push({
        ref: invoiceRecord.ref,
        type: "delete",
      });
    });
  }
}

export async function mergeDuplicateStudentAccounts({
  canonicalStudentId,
  duplicateStudentIds = [],
  mergedByEmail = "",
  mergedByUid = "",
  orgId = DEFAULT_ORG_ID,
}) {
  const cleanDuplicateIds = [...new Set(duplicateStudentIds)].filter(
    (studentId) => studentId && studentId !== canonicalStudentId,
  );

  if (!canonicalStudentId || !cleanDuplicateIds.length) {
    throw new Error("請選擇要保留的學生 ID 與要合併的重複學生。");
  }

  const db = requireFirestore();
  const canonicalRef = getStudentRef(db, orgId, canonicalStudentId);
  const canonicalSnapshot = await getDoc(canonicalRef);

  if (!canonicalSnapshot.exists()) {
    throw new Error("找不到要保留的學生帳戶。");
  }

  const duplicateSnapshots = await Promise.all(
    cleanDuplicateIds.map((studentId) => getDoc(getStudentRef(db, orgId, studentId))),
  );
  const missingDuplicate = duplicateSnapshots.find((snapshot) => !snapshot.exists());

  if (missingDuplicate) {
    throw new Error("有重複學生帳戶已不存在，請重新整理後再試一次。");
  }

  const canonicalStudent = {
    id: canonicalSnapshot.id,
    ...canonicalSnapshot.data(),
  };
  const duplicateStudents = duplicateSnapshots.map((snapshot) => ({
    id: snapshot.id,
    ...snapshot.data(),
  }));
  const branchIds = uniqueValues(
    canonicalStudent.branchIds,
    ...duplicateStudents.map((student) => student.branchIds),
  );
  const mergedStudentData = {
    branchClassKeys: uniqueValues(
      canonicalStudent.branchClassKeys,
      ...duplicateStudents.map((student) => student.branchClassKeys),
    ),
    branchClasses: uniqueObjects(
      canonicalStudent.branchClasses,
      ...duplicateStudents.map((student) => student.branchClasses),
    ),
    branchIds,
    classIds: uniqueValues(
      canonicalStudent.classIds,
      ...duplicateStudents.map((student) => student.classIds),
    ),
    classNames: uniqueValues(
      canonicalStudent.classNames,
      ...duplicateStudents.map((student) => student.classNames),
    ),
    legacyStudentNumbers: uniqueValues(
      canonicalStudent.legacyStudentNumbers,
      ...duplicateStudents.map((student) => student.legacyStudentNumbers),
    ),
    mergedByEmail,
    mergedByUid,
    mergedFromStudentIds: uniqueValues(
      canonicalStudent.mergedFromStudentIds,
      cleanDuplicateIds,
      ...duplicateStudents.map((student) => student.mergedFromStudentIds),
    ),
    mergedStudentNames: uniqueValues(
      canonicalStudent.mergedStudentNames,
      duplicateStudents.map((student) => student.name),
    ),
    name: canonicalStudent.name || duplicateStudents[0]?.name || "",
    normalizedName: normalizeStudentName(
      canonicalStudent.name || duplicateStudents[0]?.name || "",
    ),
    status: "active",
    studentId: canonicalStudentId,
    updatedAt: serverTimestamp(),
  };
  const operations = [
    {
      data: mergedStudentData,
      options: { merge: true },
      ref: canonicalRef,
      type: "set",
    },
  ];

  await updateBillingWorkspaceStudentIds({
    branchIds,
    canonicalStudentId,
    db,
    duplicateStudentIds: cleanDuplicateIds,
    operations,
    orgId,
  });
  await moveStudentSubcollections({
    canonicalStudent: mergedStudentData,
    canonicalStudentId,
    db,
    duplicateStudentIds: cleanDuplicateIds,
    operations,
    orgId,
  });

  cleanDuplicateIds.forEach((duplicateStudentId) => {
    operations.push({
      ref: getStudentRef(db, orgId, duplicateStudentId),
      type: "delete",
    });
  });

  await commitOperations(db, operations);

  return {
    canonicalStudentId,
    mergedCount: cleanDuplicateIds.length,
    operationCount: operations.length,
  };
}

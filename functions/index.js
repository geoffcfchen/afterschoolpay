const { initializeApp } = require("firebase-admin/app");
const { FieldValue, getFirestore } = require("firebase-admin/firestore");
const { HttpsError, onCall } = require("firebase-functions/v2/https");
const { logger } = require("firebase-functions");

initializeApp();

const db = getFirestore();
const REGION = "asia-east1";
const PAYMENT_METHOD_LABELS = {
  cash: "現金",
  transfer: "轉帳",
  card: "刷卡",
  linePay: "LINE Pay",
  other: "其他",
};

function cleanString(value) {
  return String(value || "").trim();
}

function requireAuth(request) {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "請先登入。");
  }

  return request.auth;
}

function normalizeAmount(value) {
  const amount = Math.round(Number(value) || 0);

  if (!Number.isFinite(amount) || amount <= 0) {
    throw new HttpsError("invalid-argument", "金額必須大於 0。");
  }

  return amount;
}

function getPaymentMethodLabel(method) {
  return PAYMENT_METHOD_LABELS[method] || method || "未記錄";
}

function createReceiptNumber(paymentRef, receivedAtIso) {
  return `RECEIPT-${receivedAtIso.slice(0, 10).replaceAll("-", "")}-${paymentRef.id
    .slice(0, 6)
    .toUpperCase()}`;
}

function hasPermission(member, permissionKey) {
  return (
    member?.status === "active" &&
    (member.roleLevel === 1 || member.permissions?.[permissionKey] === true)
  );
}

function canAccessBranch(member, branchId) {
  return (
    member?.roleLevel === 1 ||
    member?.permissions?.canViewAllBranches === true ||
    (Array.isArray(member?.branchIds) && member.branchIds.includes(branchId))
  );
}

async function loadActiveMember(orgId, uid) {
  const memberSnapshot = await db
    .doc(`organizations/${orgId}/members/${uid}`)
    .get();

  if (!memberSnapshot.exists) {
    throw new HttpsError("permission-denied", "你尚未加入此組織。");
  }

  const member = {
    id: memberSnapshot.id,
    ...memberSnapshot.data(),
  };

  if (member.status !== "active") {
    throw new HttpsError("permission-denied", "此帳號尚未開通。");
  }

  return member;
}

function publicPaymentData(paymentData) {
  return {
    ...paymentData,
    createdAt: null,
    receivedAt: null,
    updatedAt: null,
  };
}

exports.createStudentInvoicePayment = onCall(
  {
    region: REGION,
  },
  async (request) => {
    const auth = requireAuth(request);
    const orgId = cleanString(request.data?.orgId);
    const studentId = cleanString(request.data?.studentId);
    const invoiceId = cleanString(request.data?.invoiceId);
    const receivedAtBranchId = cleanString(request.data?.receivedAtBranchId);
    const method = cleanString(request.data?.method) || "cash";
    const note = cleanString(request.data?.note);
    const amount = normalizeAmount(request.data?.amount);

    if (!orgId || !studentId || !invoiceId || !receivedAtBranchId) {
      throw new HttpsError(
        "invalid-argument",
        "缺少組織、學生、通知單或收款分校資料。",
      );
    }

    const member = await loadActiveMember(orgId, auth.uid);

    if (!hasPermission(member, "canRecordDailyLedger")) {
      throw new HttpsError("permission-denied", "你沒有每日收支權限。");
    }

    if (!canAccessBranch(member, receivedAtBranchId)) {
      throw new HttpsError("permission-denied", "你沒有此分校的收款權限。");
    }

    const orgRef = db.doc(`organizations/${orgId}`);
    const branchRef = db.doc(
      `organizations/${orgId}/branches/${receivedAtBranchId}`,
    );
    const studentRef = db.doc(`organizations/${orgId}/students/${studentId}`);
    const invoiceRef = studentRef.collection("invoices").doc(invoiceId);
    const paymentRef = studentRef.collection("payments").doc();
    const auditRef = db.collection(`organizations/${orgId}/auditLogs`).doc();
    const receivedAtIso = new Date().toISOString();
    const receiptNumber = createReceiptNumber(paymentRef, receivedAtIso);
    let savedPayment = null;

    await db.runTransaction(async (transaction) => {
      const [orgSnapshot, branchSnapshot, studentSnapshot, invoiceSnapshot] =
        await Promise.all([
          transaction.get(orgRef),
          transaction.get(branchRef),
          transaction.get(studentRef),
          transaction.get(invoiceRef),
        ]);

      if (!branchSnapshot.exists) {
        throw new HttpsError("not-found", "找不到收款分校。");
      }

      if (!studentSnapshot.exists) {
        throw new HttpsError("not-found", "找不到學生帳戶。");
      }

      if (!invoiceSnapshot.exists) {
        throw new HttpsError("not-found", "找不到繳費通知單。");
      }

      const organization = orgSnapshot.data() || {};
      const branch = branchSnapshot.data() || {};
      const student = studentSnapshot.data() || {};
      const invoice = invoiceSnapshot.data() || {};
      const invoiceStatus = invoice.status || "unpaid";

      if (invoiceStatus === "void") {
        throw new HttpsError(
          "failed-precondition",
          "作廢的繳費通知單不能收款。",
        );
      }

      const invoiceTotal = Number(invoice.total) || 0;
      const paidBefore = Number(invoice.paidTotal) || 0;
      const balanceBefore = Number(invoice.balance ?? invoiceTotal) || 0;

      if (balanceBefore <= 0 || invoiceStatus === "paid") {
        throw new HttpsError(
          "failed-precondition",
          "此繳費通知單已無未收金額。",
        );
      }

      if (amount > balanceBefore) {
        throw new HttpsError(
          "invalid-argument",
          "收款金額不能大於未收金額。",
        );
      }

      const paidTotal = Math.min(invoiceTotal, paidBefore + amount);
      const balance = Math.max(balanceBefore - amount, 0);
      const nextStatus = balance <= 0 ? "paid" : invoiceStatus;
      const paymentData = {
        amount,
        balanceAfter: balance,
        balanceBefore,
        createdAt: FieldValue.serverTimestamp(),
        id: paymentRef.id,
        invoiceId,
        invoiceLineItems: invoice.lineItems || [],
        invoiceNumber: invoice.invoiceNumber || invoiceId,
        invoiceSourceBranchId: invoice.sourceBranchId || "",
        invoiceSourceBranchSnapshot: {
          id: invoice.sourceBranchSnapshot?.id || invoice.sourceBranchId || "",
          name: invoice.sourceBranchSnapshot?.name || "",
          shortName: invoice.sourceBranchSnapshot?.shortName || "",
        },
        invoiceTotal,
        method,
        methodLabel: getPaymentMethodLabel(method),
        note,
        organizationSnapshot: {
          id: orgSnapshot.id,
          name: organization.name || invoice.organizationSnapshot?.name || "",
        },
        paidBefore,
        receiptNumber,
        receivedAt: FieldValue.serverTimestamp(),
        receivedAtBranchId,
        receivedAtBranchSnapshot: {
          id: branchSnapshot.id,
          name: branch.name || "",
          shortName: branch.shortName || "",
        },
        receivedAtIso,
        receivedByEmail: member.email || auth.token.email || "",
        receivedByName:
          member.displayName || auth.token.name || member.email || auth.token.email || "",
        receivedByUid: auth.uid,
        source: "cloud-function",
        status: "completed",
        studentId,
        studentSnapshot: {
          id: studentId,
          name: student.name || invoice.studentSnapshot?.name || "",
          studentNumber:
            (Array.isArray(student.legacyStudentNumbers)
              ? student.legacyStudentNumbers.filter(Boolean)[0]
              : "") ||
            invoice.studentSnapshot?.studentNumber ||
            "",
        },
        updatedAt: FieldValue.serverTimestamp(),
      };
      const invoiceUpdate = {
        balance,
        lastPaymentAt: FieldValue.serverTimestamp(),
        lastPaymentId: paymentRef.id,
        paidTotal,
        paymentIds: FieldValue.arrayUnion(paymentRef.id),
        status: nextStatus,
        statusUpdatedByUid: auth.uid,
        updatedAt: FieldValue.serverTimestamp(),
      };

      if (nextStatus === "paid") {
        invoiceUpdate.paidAt = FieldValue.serverTimestamp();
      }

      transaction.set(paymentRef, paymentData);
      transaction.set(invoiceRef, invoiceUpdate, { merge: true });
      transaction.set(auditRef, {
        action: "studentPayment.created",
        actor: {
          email: member.email || auth.token.email || "",
          name:
            member.displayName ||
            auth.token.name ||
            member.email ||
            auth.token.email ||
            "",
          uid: auth.uid,
        },
        amount,
        branchId: receivedAtBranchId,
        createdAt: FieldValue.serverTimestamp(),
        createdAtIso: receivedAtIso,
        invoiceId,
        paymentId: paymentRef.id,
        receiptNumber,
        source: "cloud-function",
        studentId,
      });

      savedPayment = publicPaymentData(paymentData);
    });

    logger.info("Created student invoice payment", {
      invoiceId,
      orgId,
      paymentId: paymentRef.id,
      receiptNumber,
      studentId,
    });

    return {
      payment: savedPayment,
      paymentId: paymentRef.id,
      receiptNumber,
    };
  },
);

const { initializeApp } = require("firebase-admin/app");
const { FieldValue, getFirestore } = require("firebase-admin/firestore");
const { HttpsError, onCall } = require("firebase-functions/v2/https");
const { logger } = require("firebase-functions");
const { defineSecret } = require("firebase-functions/params");

initializeApp();

const db = getFirestore();
const REGION = "asia-east1";
const OPENAI_API_KEY = defineSecret("OPENAI_API_KEY");
const PAYMENT_METHOD_LABELS = {
  cash: "現金",
  transfer: "轉帳",
  card: "刷卡",
  linePay: "LINE Pay",
  other: "其他",
};
const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const DEFAULT_OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-6.2-sol";

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

function cleanPageContext(context) {
  if (!context || typeof context !== "object" || Array.isArray(context)) {
    return {};
  }

  return {
    capturedAtIso: cleanString(context.capturedAtIso),
    heading: cleanString(context.heading).slice(0, 180),
    navigationTrail: Array.isArray(context.navigationTrail)
      ? context.navigationTrail.slice(-10).map((entry) => ({
          label: cleanString(entry?.label).slice(0, 80),
          path: cleanString(entry?.path).slice(0, 240),
          visitedAtIso: cleanString(entry?.visitedAtIso),
        }))
      : [],
    pageLabel: cleanString(context.pageLabel).slice(0, 80),
    pathname: cleanString(context.pathname).slice(0, 180),
    search: cleanString(context.search).slice(0, 240),
    selectedText: cleanString(context.selectedText).slice(0, 500),
    url: cleanString(context.url).slice(0, 320),
    viewport: cleanString(context.viewport).slice(0, 40),
  };
}

function buildRequestTitle(content) {
  const text = cleanString(content).replace(/\s+/g, " ");

  if (!text) {
    return "新的產品需求";
  }

  return text.length > 26 ? `${text.slice(0, 26)}...` : text;
}

function buildAssistantFallbackReply(content) {
  if (!cleanString(content)) {
    return "我會先記錄目前頁面脈絡。請描述你想調整的流程、看到的問題，或希望完成的結果。";
  }

  return "我已記錄這段需求與目前頁面脈絡。請再補充預期結果、目前不符合的地方，以及是否有範例畫面或資料。需求清楚後，可以送出建立 PR。";
}

function extractOpenAiText(responseData) {
  if (typeof responseData?.output_text === "string") {
    return responseData.output_text.trim();
  }

  const outputText = [];

  for (const item of responseData?.output || []) {
    for (const content of item?.content || []) {
      if (typeof content?.text === "string") {
        outputText.push(content.text);
      }
    }
  }

  return outputText.join("\n").trim();
}

async function generateAiAssistantReply({
  content,
  pageContext,
  priorMessages = [],
  requestData = {},
}) {
  const apiKey = OPENAI_API_KEY.value();

  if (!apiKey) {
    return buildAssistantFallbackReply(content);
  }

  try {
    const response = await fetch(OPENAI_RESPONSES_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        input: [
          {
            role: "system",
            content:
              "你是 Afterschool Pay 的產品需求助手。使用繁體中文，服務台灣補習班使用者。你的工作是根據目前頁面、瀏覽脈絡與對話，幫使用者釐清需求。若需求仍不清楚，最多問 3 個具體問題。若需求已清楚，整理成簡短驗收條件，並提醒可送出建立 PR。不要承諾已經完成程式修改。",
          },
          {
            role: "user",
            content: JSON.stringify({
              currentMessage: content,
              pageContext,
              priorMessages: priorMessages.map((message) => ({
                content: message.content,
                role: message.role,
              })),
              request: {
                status: requestData.status || "",
                title: requestData.title || "",
              },
            }),
          },
        ],
        max_output_tokens: 520,
        model: DEFAULT_OPENAI_MODEL,
      }),
    });

    if (!response.ok) {
      logger.warn("OpenAI assistant reply failed", {
        status: response.status,
        statusText: response.statusText,
      });

      return buildAssistantFallbackReply(content);
    }

    const responseData = await response.json();
    const reply = extractOpenAiText(responseData);

    return reply || buildAssistantFallbackReply(content);
  } catch (error) {
    logger.warn("OpenAI assistant reply errored", {
      message: error?.message || String(error),
    });

    return buildAssistantFallbackReply(content);
  }
}

async function loadRecentAiMessages(orgId, requestId) {
  const snapshot = await db
    .collection(`organizations/${orgId}/aiRequests/${requestId}/messages`)
    .orderBy("createdAt", "desc")
    .limit(16)
    .get();

  return snapshot.docs
    .map((record) => ({
      id: record.id,
      ...record.data(),
    }))
    .reverse();
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

exports.createAiAssistantRequest = onCall(
  {
    region: REGION,
    secrets: [OPENAI_API_KEY],
  },
  async (request) => {
    const auth = requireAuth(request);
    const orgId = cleanString(request.data?.orgId);
    const content = cleanString(request.data?.content);
    const pageContext = cleanPageContext(request.data?.context);

    if (!orgId || !content) {
      throw new HttpsError("invalid-argument", "缺少組織或需求內容。");
    }

    const member = await loadActiveMember(orgId, auth.uid);
    const requestRef = db.collection(`organizations/${orgId}/aiRequests`).doc();
    const userMessageRef = requestRef.collection("messages").doc();
    const assistantMessageRef = requestRef.collection("messages").doc();
    const auditRef = db.collection(`organizations/${orgId}/auditLogs`).doc();
    const reply = await generateAiAssistantReply({
      content,
      pageContext,
    });
    const actor = {
      email: member.email || auth.token.email || "",
      name:
        member.displayName ||
        auth.token.name ||
        member.email ||
        auth.token.email ||
        "",
      uid: auth.uid,
    };

    await db.batch()
      .set(requestRef, {
        createdAt: FieldValue.serverTimestamp(),
        createdByEmail: actor.email,
        createdByName: actor.name,
        createdByUid: actor.uid,
        githubPrUrl: "",
        lastMessage: content,
        pageContext,
        previewUrl: "",
        source: "in-app-ai-assistant",
        status: "clarifying",
        title: buildRequestTitle(content),
        updatedAt: FieldValue.serverTimestamp(),
      })
      .set(userMessageRef, {
        authorEmail: actor.email,
        authorName: actor.name,
        authorUid: actor.uid,
        content,
        createdAt: FieldValue.serverTimestamp(),
        pageContext,
        role: "user",
      })
      .set(assistantMessageRef, {
        authorEmail: "",
        authorName: "Afterschool Pay AI",
        authorUid: "system",
        content: reply,
        createdAt: FieldValue.serverTimestamp(),
        pageContext,
        role: "assistant",
      })
      .set(auditRef, {
        action: "aiAssistant.requestCreated",
        actor,
        createdAt: FieldValue.serverTimestamp(),
        orgId,
        requestId: requestRef.id,
        source: "cloud-function",
      })
      .commit();

    logger.info("Created AI assistant request", {
      orgId,
      requestId: requestRef.id,
      uid: auth.uid,
    });

    return {
      requestId: requestRef.id,
    };
  },
);

exports.sendAiAssistantMessage = onCall(
  {
    region: REGION,
    secrets: [OPENAI_API_KEY],
  },
  async (request) => {
    const auth = requireAuth(request);
    const orgId = cleanString(request.data?.orgId);
    const requestId = cleanString(request.data?.requestId);
    const content = cleanString(request.data?.content);
    const pageContext = cleanPageContext(request.data?.context);

    if (!orgId || !requestId || !content) {
      throw new HttpsError("invalid-argument", "缺少組織、需求或訊息內容。");
    }

    const member = await loadActiveMember(orgId, auth.uid);
    const requestRef = db.doc(`organizations/${orgId}/aiRequests/${requestId}`);
    const requestSnapshot = await requestRef.get();

    if (!requestSnapshot.exists) {
      throw new HttpsError("not-found", "找不到這筆 AI 需求。");
    }

    const requestData = requestSnapshot.data() || {};
    const priorMessages = await loadRecentAiMessages(orgId, requestId);
    const reply = await generateAiAssistantReply({
      content,
      pageContext,
      priorMessages,
      requestData,
    });
    const userMessageRef = requestRef.collection("messages").doc();
    const assistantMessageRef = requestRef.collection("messages").doc();
    const actor = {
      email: member.email || auth.token.email || "",
      name:
        member.displayName ||
        auth.token.name ||
        member.email ||
        auth.token.email ||
        "",
      uid: auth.uid,
    };

    await db.batch()
      .set(userMessageRef, {
        authorEmail: actor.email,
        authorName: actor.name,
        authorUid: actor.uid,
        content,
        createdAt: FieldValue.serverTimestamp(),
        pageContext,
        role: "user",
      })
      .set(assistantMessageRef, {
        authorEmail: "",
        authorName: "Afterschool Pay AI",
        authorUid: "system",
        content: reply,
        createdAt: FieldValue.serverTimestamp(),
        pageContext,
        role: "assistant",
      })
      .set(
        requestRef,
        {
          lastMessage: content,
          pageContext,
          status:
            requestData.status === "queued_for_pr" ||
            requestData.status === "pr_open" ||
            requestData.status === "preview_ready"
              ? requestData.status
              : "clarifying",
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      )
      .commit();

    logger.info("Saved AI assistant message", {
      orgId,
      requestId,
      uid: auth.uid,
    });

    return {
      requestId,
    };
  },
);

exports.queueAiAssistantPr = onCall(
  {
    region: REGION,
  },
  async (request) => {
    const auth = requireAuth(request);
    const orgId = cleanString(request.data?.orgId);
    const requestId = cleanString(request.data?.requestId);

    if (!orgId || !requestId) {
      throw new HttpsError("invalid-argument", "缺少組織或需求資料。");
    }

    const member = await loadActiveMember(orgId, auth.uid);
    const requestRef = db.doc(`organizations/${orgId}/aiRequests/${requestId}`);
    const messageRef = requestRef.collection("messages").doc();
    const auditRef = db.collection(`organizations/${orgId}/auditLogs`).doc();
    const queuedAtIso = new Date().toISOString();
    const actor = {
      email: member.email || auth.token.email || "",
      name:
        member.displayName ||
        auth.token.name ||
        member.email ||
        auth.token.email ||
        "",
      uid: auth.uid,
    };

    await db.runTransaction(async (transaction) => {
      const requestSnapshot = await transaction.get(requestRef);

      if (!requestSnapshot.exists) {
        throw new HttpsError("not-found", "找不到這筆 AI 需求。");
      }

      transaction.set(
        requestRef,
        {
          prAutomationStatus: "queued",
          queuedForPrAt: FieldValue.serverTimestamp(),
          queuedForPrAtIso: queuedAtIso,
          queuedForPrByEmail: actor.email,
          queuedForPrByName: actor.name,
          queuedForPrByUid: actor.uid,
          status: "queued_for_pr",
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      transaction.set(messageRef, {
        authorEmail: "",
        authorName: "Afterschool Pay AI",
        authorUid: "system",
        content:
          "已收到，我會把這個需求放進建立 PR 佇列。下一階段會由後端 worker 讀取這段對話、建立 GitHub PR，並回填預覽連結。",
        createdAt: FieldValue.serverTimestamp(),
        pageContext: requestSnapshot.data()?.pageContext || {},
        role: "assistant",
      });
      transaction.set(auditRef, {
        action: "aiAssistant.prQueued",
        actor,
        createdAt: FieldValue.serverTimestamp(),
        createdAtIso: queuedAtIso,
        requestId,
        source: "cloud-function",
      });
    });

    logger.info("Queued AI assistant request for PR", {
      orgId,
      requestId,
      uid: auth.uid,
    });

    return {
      requestId,
      status: "queued_for_pr",
    };
  },
);

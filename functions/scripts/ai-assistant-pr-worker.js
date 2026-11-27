const fs = require("fs");
const path = require("path");
const { initializeApp, applicationDefault } = require("firebase-admin/app");
const { FieldValue, getFirestore } = require("firebase-admin/firestore");

const mode = process.argv[2];
let orgId = process.env.ORG_ID;
let requestId = process.env.REQUEST_ID;
const projectId = process.env.FIREBASE_PROJECT_ID;

if (!mode) {
  console.error("Usage: node ai-assistant-pr-worker.js <export|sync>");
  process.exit(1);
}

initializeApp({
  credential: applicationDefault(),
  projectId,
});

const db = getFirestore();

function cleanText(value) {
  return String(value || "").trim();
}

function formatTimestamp(value) {
  if (!value) {
    return "";
  }

  const date = typeof value.toDate === "function" ? value.toDate() : new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return date.toISOString();
}

function markdownEscape(value) {
  return cleanText(value).replaceAll("|", "\\|");
}

function writeGithubOutput(values) {
  const outputPath = process.env.GITHUB_OUTPUT;

  if (!outputPath) {
    return;
  }

  const output = Object.entries(values)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  fs.appendFileSync(outputPath, `${output}\n`);
}

function buildRequestMarkdown({ messages, request }) {
  const pageContext = request.pageContext || {};
  const lines = [
    `# AI 需求：${request.title || requestId}`,
    "",
    "這份文件由 Afterschool Pay 的 AI 需求助手自動產生，目的是讓工程 PR 保留完整需求脈絡。",
    "",
    "## 狀態",
    "",
    `- Firestore request id: \`${requestId}\``,
    `- Organization id: \`${orgId}\``,
    `- 需求狀態: \`${request.status || "queued_for_pr"}\``,
    `- 建立者: ${request.createdByName || ""} ${request.createdByEmail ? `<${request.createdByEmail}>` : ""}`,
    `- 建立時間: ${formatTimestamp(request.createdAt) || request.queuedForPrAtIso || ""}`,
    "",
    "## 頁面脈絡",
    "",
    "| 欄位 | 內容 |",
    "| --- | --- |",
    `| 頁面 | ${markdownEscape(pageContext.pageLabel)} |`,
    `| 路徑 | \`${markdownEscape(pageContext.pathname)}${markdownEscape(pageContext.search)}\` |`,
    `| 標題 | ${markdownEscape(pageContext.heading)} |`,
    `| 視窗 | ${markdownEscape(pageContext.viewport)} |`,
    `| 選取文字 | ${markdownEscape(pageContext.selectedText)} |`,
    "",
    "## 最近瀏覽路徑",
    "",
  ];

  if (Array.isArray(pageContext.navigationTrail) && pageContext.navigationTrail.length) {
    pageContext.navigationTrail.forEach((entry, index) => {
      lines.push(
        `${index + 1}. ${entry.label || "頁面"} - \`${entry.path || ""}\` (${entry.visitedAtIso || ""})`,
      );
    });
  } else {
    lines.push("- 未記錄");
  }

  lines.push("", "## 對話紀錄", "");

  messages.forEach((message, index) => {
    const speaker = message.role === "user" ? "使用者" : "AI 助手";
    lines.push(
      `### ${index + 1}. ${speaker}`,
      "",
      cleanText(message.content) || "(空白)",
      "",
      `> ${formatTimestamp(message.createdAt)}`,
      "",
    );
  });

  lines.push(
    "## Codex 實作提示",
    "",
    "請根據上方對話與頁面脈絡判斷需求是否足夠明確。",
    "",
    "- 如果需求仍不清楚，先在原本 AI 需求對話中回覆需要補充的問題。",
    "- 如果需求已清楚，請直接修改產品程式碼、加入必要測試，並更新這個 PR。",
    "- UI 文案需使用繁體中文，因為主要使用者是台灣補習班工作人員。",
    "- 完成後請確認 `npm run lint`、`npm run build`、`npm --prefix functions run lint` 是否通過。",
    "",
  );

  return `${lines.join("\n")}\n`;
}

async function findQueuedRequest() {
  const snapshot = await db
    .collectionGroup("aiRequests")
    .where("status", "==", "queued_for_pr")
    .limit(10)
    .get();

  for (const record of snapshot.docs) {
    const data = record.data() || {};

    if (data.githubPrUrl) {
      continue;
    }

    if (
      data.prAutomationStatus &&
      !["queued", "worker_exported_request"].includes(data.prAutomationStatus)
    ) {
      continue;
    }

    const organizationRef = record.ref.parent.parent;

    if (!organizationRef) {
      continue;
    }

    return {
      orgId: organizationRef.id,
      requestId: record.id,
    };
  }

  return null;
}

async function exportRequest() {
  if (!orgId || !requestId) {
    const queuedRequest = await findQueuedRequest();

    if (!queuedRequest) {
      writeGithubOutput({
        found: "false",
      });
      console.log("No queued AI assistant requests found.");
      return;
    }

    orgId = queuedRequest.orgId;
    requestId = queuedRequest.requestId;
  }

  const requestRef = db.doc(`organizations/${orgId}/aiRequests/${requestId}`);
  const requestSnapshot = await requestRef.get();

  if (!requestSnapshot.exists) {
    throw new Error(`AI request not found: ${orgId}/${requestId}`);
  }

  const messagesSnapshot = await requestRef
    .collection("messages")
    .orderBy("createdAt", "asc")
    .get();
  const request = {
    id: requestSnapshot.id,
    ...requestSnapshot.data(),
  };
  const messages = messagesSnapshot.docs.map((record) => ({
    id: record.id,
    ...record.data(),
  }));
  const outputDir = path.resolve("docs", "ai-requests");
  const outputPath = path.join(outputDir, `${requestId}.md`);
  const bodyPath = path.join(outputDir, `${requestId}-pr-body.md`);
  const markdown = buildRequestMarkdown({ messages, request });

  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(outputPath, markdown);
  fs.writeFileSync(
    bodyPath,
    [
      `由 AI 需求助手建立。`,
      "",
      `Firestore request id: \`${requestId}\``,
      `Organization id: \`${orgId}\``,
      "",
      "請依照 PR 內的需求文件進行後續實作與驗證。",
    ].join("\n"),
  );

  await requestRef.set(
    {
      prAutomationStatus: "worker_exported_request",
      prBodyPath: bodyPath,
      prRequestPath: outputPath,
      status: "queued_for_pr",
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  writeGithubOutput({
    found: "true",
    org_id: orgId,
    request_id: requestId,
  });

  console.log(JSON.stringify({ bodyPath, outputPath }));
}

async function syncPrUrl() {
  const prUrl = cleanText(process.env.PR_URL);
  const branchName = cleanText(process.env.PR_BRANCH);

  if (!orgId || !requestId || !prUrl) {
    throw new Error("PR_URL is required for sync mode.");
  }

  await db.doc(`organizations/${orgId}/aiRequests/${requestId}`).set(
    {
      githubPrUrl: prUrl,
      prAutomationStatus: "pr_opened",
      prBranch: branchName,
      status: "pr_open",
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  console.log(JSON.stringify({ prUrl }));
}

async function main() {
  if (mode === "export") {
    await exportRequest();
    return;
  }

  if (mode === "sync") {
    await syncPrUrl();
    return;
  }

  throw new Error(`Unknown mode: ${mode}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

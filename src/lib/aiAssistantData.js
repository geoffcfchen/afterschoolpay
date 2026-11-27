import {
  collection,
  limit,
  onSnapshot,
  orderBy,
  query,
} from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { cloudFunctions } from "./firebase";
import { DEFAULT_ORG_ID } from "./orgData";
import { realtimeFirestore } from "./realtimeFirestore";

const REQUEST_LIMIT = 12;
const MESSAGE_LIMIT = 80;

const requireFirestore = () => {
  if (!realtimeFirestore) {
    throw new Error("Firebase 尚未設定完成，無法使用 AI 助手。");
  }

  return realtimeFirestore;
};

const cleanText = (value) => String(value || "").trim();

const requireCloudFunctions = () => {
  if (!cloudFunctions) {
    throw new Error("Firebase Functions 尚未設定完成，無法使用 AI 助手。");
  }

  return cloudFunctions;
};

function getRequestsCollection(db, orgId) {
  return collection(db, "organizations", orgId, "aiRequests");
}

function getMessagesCollection(db, orgId, requestId) {
  return collection(
    db,
    "organizations",
    orgId,
    "aiRequests",
    requestId,
    "messages",
  );
}

export function subscribeAiRequests({
  onChange,
  onError,
  orgId = DEFAULT_ORG_ID,
}) {
  const db = requireFirestore();
  const requestQuery = query(
    getRequestsCollection(db, orgId),
    orderBy("updatedAt", "desc"),
    limit(REQUEST_LIMIT),
  );

  return onSnapshot(
    requestQuery,
    (snapshot) => {
      onChange(
        snapshot.docs.map((record) => ({
          id: record.id,
          ...record.data(),
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

export function subscribeAiMessages({
  onChange,
  onError,
  orgId = DEFAULT_ORG_ID,
  requestId,
}) {
  if (!requestId) {
    onChange([]);

    return () => {};
  }

  const db = requireFirestore();
  const messageQuery = query(
    getMessagesCollection(db, orgId, requestId),
    orderBy("createdAt", "asc"),
    limit(MESSAGE_LIMIT),
  );

  return onSnapshot(
    messageQuery,
    (snapshot) => {
      onChange(
        snapshot.docs.map((record) => ({
          id: record.id,
          ...record.data(),
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

export async function createAiRequest({
  content,
  context,
  orgId = DEFAULT_ORG_ID,
}) {
  const trimmedContent = cleanText(content);

  if (!trimmedContent) {
    throw new Error("請先輸入需求內容。");
  }

  const createRequest = httpsCallable(
    requireCloudFunctions(),
    "createAiAssistantRequest",
  );
  const result = await createRequest({
    content: trimmedContent,
    context,
    orgId,
  });

  return result.data?.requestId;
}

export async function addAiMessage({
  content,
  context,
  orgId = DEFAULT_ORG_ID,
  requestId,
}) {
  const trimmedContent = cleanText(content);

  if (!requestId || !trimmedContent) {
    throw new Error("缺少需求或訊息內容。");
  }

  const sendMessage = httpsCallable(
    requireCloudFunctions(),
    "sendAiAssistantMessage",
  );

  return sendMessage({
    content: trimmedContent,
    context,
    orgId,
    requestId,
  });
}

export async function queueAiAssistantPr({
  orgId = DEFAULT_ORG_ID,
  requestId,
}) {
  if (!requestId) {
    throw new Error("缺少需求資料。");
  }

  const queueRequest = httpsCallable(
    requireCloudFunctions(),
    "queueAiAssistantPr",
  );

  return queueRequest({
    orgId,
    requestId,
  });
}

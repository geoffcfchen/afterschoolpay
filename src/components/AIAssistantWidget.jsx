import { useEffect, useRef, useState } from "react";
import { onAuthStateChanged } from "firebase/auth";
import { useLocation } from "react-router-dom";
import { auth } from "../lib/firebase";
import {
  addAiMessage,
  createAiRequest,
  queueAiAssistantPr,
  subscribeAiMessages,
  subscribeAiRequests,
} from "../lib/aiAssistantData";
import { loadOrganizationWorkspace } from "../lib/orgData";

const STATUS_LABELS = {
  clarifying: "釐清中",
  ready_for_pr: "可建立 PR",
  queued_for_pr: "等待建立 PR",
  pr_open: "PR 已建立",
  preview_ready: "預覽可看",
  updated: "已更新",
};

const HIDDEN_PATHS = new Set(["/", "/login", "/register-email"]);

function formatDateTime(value) {
  if (!value) {
    return "";
  }

  const date =
    typeof value?.toDate === "function" ? value.toDate() : new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return `${date.getMonth() + 1}/${date.getDate()} ${String(
    date.getHours(),
  ).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function getPageLabel(pathname) {
  if (pathname.startsWith("/students-courses")) {
    return "學生與課程";
  }

  if (pathname.startsWith("/daily-ledger")) {
    return "每日收支";
  }

  if (pathname.startsWith("/financial-summary")) {
    return "收支總覽";
  }

  if (pathname.startsWith("/teacher-payroll")) {
    return "老師薪資";
  }

  if (pathname.startsWith("/team-access")) {
    return "團隊權限";
  }

  if (pathname.startsWith("/dashboard")) {
    return "工作區";
  }

  return "目前頁面";
}

function getVisibleHeading() {
  if (typeof document === "undefined") {
    return "";
  }

  const heading = document.querySelector("main h1, main h2, h1, h2");

  return heading?.textContent?.trim() || "";
}

function buildContext(location, navigationTrail) {
  const url =
    typeof window === "undefined"
      ? `${location.pathname}${location.search}`
      : window.location.href;

  return {
    capturedAtIso: new Date().toISOString(),
    heading: getVisibleHeading(),
    navigationTrail,
    pageLabel: getPageLabel(location.pathname),
    pathname: location.pathname,
    search: location.search,
    selectedText:
      typeof window === "undefined"
        ? ""
        : window.getSelection()?.toString().trim().slice(0, 500) || "",
    url,
    viewport:
      typeof window === "undefined"
        ? ""
        : `${window.innerWidth}x${window.innerHeight}`,
  };
}

function AIAssistantWidget() {
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [authStatus, setAuthStatus] = useState(auth ? "checking" : "hidden");
  const [currentUser, setCurrentUser] = useState(null);
  const [workspace, setWorkspace] = useState(null);
  const [requests, setRequests] = useState([]);
  const [messages, setMessages] = useState([]);
  const [activeRequestId, setActiveRequestId] = useState("");
  const [draft, setDraft] = useState("");
  const [saveStatus, setSaveStatus] = useState("idle");
  const [error, setError] = useState("");
  const navigationTrailRef = useRef([]);
  const messagesEndRef = useRef(null);

  useEffect(() => {
    const entry = {
      label: getPageLabel(location.pathname),
      path: `${location.pathname}${location.search}`,
      visitedAtIso: new Date().toISOString(),
    };
    const current = navigationTrailRef.current;
    const last = current[current.length - 1];

    if (last?.path !== entry.path) {
      navigationTrailRef.current = [...current, entry].slice(-10);
    }
  }, [location.pathname, location.search]);

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
        setRequests([]);
        setMessages([]);
        setActiveRequestId("");
        return;
      }

      setAuthStatus("loading");
      setError("");

      try {
        const nextWorkspace = await loadOrganizationWorkspace(user);

        if (!active) {
          return;
        }

        setWorkspace(nextWorkspace);
        setAuthStatus("ready");
      } catch (loadError) {
        console.error("Unable to load AI assistant workspace:", loadError);

        if (active) {
          setAuthStatus("error");
          setWorkspace(null);
        }
      }
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (authStatus !== "ready" || !workspace?.activeOrgId) {
      return undefined;
    }

    return subscribeAiRequests({
      onChange: (nextRequests) => {
        setRequests(nextRequests);
        setActiveRequestId((current) => current || nextRequests[0]?.id || "");
      },
      onError: (requestError) => {
        console.error("Unable to listen to AI requests:", requestError);
        setError("目前無法讀取需求紀錄。請確認 Firestore rules 已發布。");
      },
      orgId: workspace.activeOrgId,
    });
  }, [authStatus, workspace?.activeOrgId]);

  useEffect(() => {
    if (!workspace?.activeOrgId || !activeRequestId) {
      return undefined;
    }

    return subscribeAiMessages({
      onChange: setMessages,
      onError: (messageError) => {
        console.error("Unable to listen to AI messages:", messageError);
        setError("目前無法讀取這個需求的對話。");
      },
      orgId: workspace.activeOrgId,
      requestId: activeRequestId,
    });
  }, [activeRequestId, workspace?.activeOrgId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: "end" });
  }, [messages, open]);

  const activeRequest =
    requests.find((request) => request.id === activeRequestId) || null;
  const visibleMessages = activeRequestId ? messages : [];
  const canQueueForPr =
    activeRequestId &&
    activeRequest?.status !== "queued_for_pr" &&
    activeRequest?.status !== "pr_open" &&
    activeRequest?.status !== "preview_ready";

  const shouldHide =
    HIDDEN_PATHS.has(location.pathname) ||
    authStatus === "hidden" ||
    authStatus === "signed-out" ||
    authStatus === "error";

  if (shouldHide) {
    return null;
  }

  const pageLabel = getPageLabel(location.pathname);
  const pagePath = `${location.pathname}${location.search}`;
  const disabled = authStatus !== "ready" || saveStatus === "saving";

  const handleSubmit = async (event) => {
    event.preventDefault();

    if (!draft.trim() || !currentUser || !workspace?.activeOrgId) {
      return;
    }

    setSaveStatus("saving");
    setError("");

    try {
      const context = buildContext(location, navigationTrailRef.current);

      if (!activeRequestId) {
        const requestId = await createAiRequest({
          content: draft,
          context,
          orgId: workspace.activeOrgId,
          user: currentUser,
        });
        setActiveRequestId(requestId);
      } else {
        await addAiMessage({
          content: draft,
          context,
          orgId: workspace.activeOrgId,
          requestId: activeRequestId,
          role: "user",
          user: currentUser,
        });
      }

      setDraft("");
      setSaveStatus("idle");
    } catch (saveError) {
      console.error("Unable to save AI assistant message:", saveError);
      setError(saveError.message || "目前無法儲存需求，請稍後再試。");
      setSaveStatus("error");
    }
  };

  const startNewRequest = () => {
    setActiveRequestId("");
    setMessages([]);
    setDraft("");
    setError("");
  };

  const queueForPr = async () => {
    if (!workspace?.activeOrgId || !activeRequestId) {
      return;
    }

    setSaveStatus("saving");
    setError("");

    try {
      await queueAiAssistantPr({
        orgId: workspace.activeOrgId,
        requestId: activeRequestId,
      });
      setSaveStatus("idle");
    } catch (statusError) {
      console.error("Unable to update AI request status:", statusError);
      setError("目前無法送出建立 PR，請稍後再試。");
      setSaveStatus("error");
    }
  };

  return (
    <aside className={`ai-assistant-widget ${open ? "open" : ""}`}>
      {open ? (
        <section className="ai-assistant-panel" aria-label="AI 需求助手">
          <header className="ai-assistant-header">
            <div>
              <span>AI 需求助手</span>
              <strong>{workspace?.organization?.name || "工作區"}</strong>
            </div>
            <button
              aria-label="關閉 AI 需求助手"
              onClick={() => setOpen(false)}
              type="button"
            >
              ×
            </button>
          </header>

          <div className="ai-assistant-context">
            <span>目前頁面</span>
            <strong>{pageLabel}</strong>
            <small>{pagePath}</small>
          </div>

          <div className="ai-assistant-body">
            <div className="ai-request-list" aria-label="需求紀錄">
              <button
                className={!activeRequestId ? "active" : ""}
                onClick={startNewRequest}
                type="button"
              >
                + 新需求
              </button>
              {requests.map((request) => (
                <button
                  className={request.id === activeRequestId ? "active" : ""}
                  key={request.id}
                  onClick={() => setActiveRequestId(request.id)}
                  type="button"
                >
                  <strong>{request.title || "未命名需求"}</strong>
                  <span>{STATUS_LABELS[request.status] || "紀錄中"}</span>
                </button>
              ))}
            </div>

            <div className="ai-chat-column">
              <div className="ai-request-meta">
                <div>
                  <span>狀態</span>
                  <strong>
                    {activeRequest
                      ? STATUS_LABELS[activeRequest.status] || "紀錄中"
                      : "新需求"}
                  </strong>
                </div>
                {activeRequest?.githubPrUrl ? (
                  <a href={activeRequest.githubPrUrl} rel="noreferrer" target="_blank">
                    PR
                  </a>
                ) : null}
                {activeRequest?.previewUrl ? (
                  <a href={activeRequest.previewUrl} rel="noreferrer" target="_blank">
                    預覽
                  </a>
                ) : null}
                {canQueueForPr ? (
                  <button
                    disabled={disabled}
                    onClick={queueForPr}
                    type="button"
                  >
                    送出建立 PR
                  </button>
                ) : null}
              </div>

              <div className="ai-message-list" aria-live="polite">
                {!activeRequestId && !visibleMessages.length ? (
                  <div className="ai-empty-state">
                    <strong>描述你想改的地方</strong>
                    <p>
                      我會一起記錄目前頁面、最近瀏覽路徑與對話內容。需求清楚後，
                      後端 worker 就可以接手建立 PR 與預覽連結。
                    </p>
                  </div>
                ) : null}
                {visibleMessages.map((message) => (
                  <article
                    className={`ai-message ${message.role === "user" ? "user" : "assistant"}`}
                    key={message.id}
                  >
                    <p>{message.content}</p>
                    <span>
                      {message.role === "user" ? "你" : "AI 助手"}
                      {formatDateTime(message.createdAt)
                        ? ` · ${formatDateTime(message.createdAt)}`
                        : ""}
                    </span>
                  </article>
                ))}
                <div ref={messagesEndRef} />
              </div>

              {error ? <p className="ai-assistant-error">{error}</p> : null}

              <form className="ai-assistant-form" onSubmit={handleSubmit}>
                <textarea
                  disabled={disabled}
                  onChange={(event) => setDraft(event.target.value)}
                  placeholder="例如：每日收支的學生列表在手機上太難滑，想要改成可以快速搜尋學生。"
                  rows={3}
                  value={draft}
                />
                <button disabled={disabled || !draft.trim()} type="submit">
                  {saveStatus === "saving" ? "儲存中..." : "送出"}
                </button>
              </form>
            </div>
          </div>
        </section>
      ) : null}

      <button
        aria-label="開啟 AI 需求助手"
        className="ai-assistant-fab"
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        AI
      </button>
    </aside>
  );
}

export default AIAssistantWidget;

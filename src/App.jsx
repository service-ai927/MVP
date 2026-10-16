import { useCallback, useEffect, useMemo, useState, useRef } from "react";
import {
  Check,
  Upload,
  ChevronRight,
  Clock3,
  FileText,
  Pencil,
  Search,
  Sparkles,
  User,
  RefreshCw,
  PlusCircle,
  Download,
  RotateCcw,
  BarChart3,
  BookOpen,
  Inbox,
  ShieldCheck,
  ShieldAlert,
  ThumbsUp,
  ThumbsDown,
  Timer,
  Send,
  Pause,
  Play,
  ArrowRight
} from "lucide-react";
import "./App.css";

const CLASSIFICATION_CATEGORIES = [
  "お礼への返信",
  "マーケ相談",
  "進捗報告",
  "動画相談",
  "カジュアルな質問",
  "日程・MTGの日時",
  "金額・条件・契約",
  "実績の数字を聞かれている",
  "断り・クレーム・こじれ",
  "知り合い・元同僚からの連絡",
  "業者の一斉営業",
  "リンクだけのDM",
  "スパム",
  "その他・不明",
];

const CLASSIFICATION_ACTIONS = [
  { value: "auto", label: "AI返信案を作成" },
  { value: "escalate", label: "担当者による確認" },
  { value: "skip", label: "返信不要" },
];

const STATUS_FILTERS = [
  "All",
  "New",
  "Needs review",
  "Draft generated",
  "On hold",
  "Returned for revision",
  "Completed",
];

const CHANNELS = ["All", "x", "linkedin", "email"];

const STATUS_LABELS = {
  All: "すべて",
  New: "新着",
  "Needs review": "確認が必要",
  "Draft generated": "返信案を生成済み",
  "On hold": "保留中",
  "Returned for revision": "修正のため差し戻し",
  Completed: "完了",
};

const ACTION_LABELS = {
  auto: "AI返信案",
  escalate: "担当者確認",
  skip: "返信不要",
  pending: "未分類",
};

function getStatusLabel(status) {
  return STATUS_LABELS[status] || status;
}

function getActionLabel(action) {
  return ACTION_LABELS[action] || action;
}

function mapThread(item) {
  const classification = item.classification ?? {};
  const draft = item.draft ?? {};
  const thread = item.thread ?? {};
  const counterpart = item.counterpart ?? {};
  const medium = item.medium ?? {};

  let status = "New";

  if (
    draft.send_status === "sent" ||
    draft.send_status === "not_needed" ||
    thread.status === "handled"
  ) {
    status = "Completed";
  } else if (thread.status === "on_hold") {
    status = "On hold";
  } else if (thread.status === "returned_for_revision") {
    status = "Returned for revision";
  } else if (
    thread.status === "needs_review" ||
    classification.action === "escalate" ||
    thread.status === "held"
  ) {
    status = "Needs review";
  } else if (draft.generated) {
    status = "Draft generated";
  }

  return {
    id: thread.id,
    name: counterpart.id || counterpart.handle || "不明",
    handle: counterpart.handle || "",
    profileUrl: counterpart.profile_url || "",
    memo: counterpart.memo || "",
    channel: medium.type || "x",
    account: medium.account || "標準",
    status,
    rawStatus: thread.status,
    action: classification.action || "auto",
    category: classification.category || "未分類",
    reason: classification.reason || "分類理由はまだありません。",
    ruleHit: classification.rule_hit || "",
    decidedBy: classification.decided_by || "",
    messages: (item.messages || []).map((message) => ({
      fromMe: message.from === "me",
      text: message.text || "",
      time: message.at || "",
    })),
    draft: draft.edited || draft.generated || "",
    draftGenerated: draft.generated || "",
    draftEdited: draft.edited || "",
    gate: draft.gate || "-",
    sendStatus: draft.send_status || "",
    handlingTimeSeconds: item.handling_time_seconds || 0,
    qualityRating: item.quality_rating || null,
    qualityFeedback: item.quality_feedback || "",
    raw: item,
  };
}

function getStatusClass(status) {
  return status.toLowerCase().replaceAll(" ", "-");
}

function formatDuration(seconds) {
  if (!seconds || seconds <= 0) return "0s";
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (mins === 0) return `${secs}s`;
  return `${mins}m ${secs}s`;
}

export default function App() {
  const [activeTab, setActiveTab] = useState("inbox"); // 'inbox', 'metrics', 'criteria'
  const [threads, setThreads] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notification, setNotification] = useState("");

  // Filters
  const [filter, setFilter] = useState("All");
  const [channelFilter, setChannelFilter] = useState("All");
  const [search, setSearch] = useState("");

  // Editing state
  const [editingDraft, setEditingDraft] = useState(false);
  const [draftEditText, setDraftEditText] = useState("");
  const [editingMemo, setEditingMemo] = useState(false);
  const [memoDraft, setMemoDraft] = useState("");
  const [editingClassification, setEditingClassification] = useState(false);
  const [classificationDraft, setClassificationDraft] = useState({
    action: "auto",
    category: "",
    reason: "",
  });

  // Modals & UI actions
  const [showSimulateModal, setShowSimulateModal] = useState(false);
  const [newSimMsg, setNewSimMsg] = useState({
    contactName: "",
    handle: "",
    platform: "x",
    account: "アウトリーチ担当",
    memo: "",
    messageText: "",
  });
  const [customTone, setCustomTone] = useState("warm");
  const [customGuidance, setCustomGuidance] = useState("");
  const [isRegenerating, setIsRegenerating] = useState(false);
  const [isTriaging, setIsTriaging] = useState(false);

  // Metrics Data
  const [metrics, setMetrics] = useState(null);

  // Active Handling Stopwatch
  const [stopwatchSeconds, setStopwatchSeconds] = useState(0);
  const [stopwatchActive, setStopwatchActive] = useState(false);
  const timerRef = useRef(null);

  // Notification helper
  const notify = (msg) => {
    setNotification(msg);
    setTimeout(() => setNotification(""), 4500);
  };

  // Load threads
  const loadThreads = useCallback(async () => {
    try {
      setLoading(true);
      setError("");
      const res = await fetch("/api/threads");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const mapped = data.threads.map(mapThread);
      setThreads(mapped);
      if (mapped.length > 0) {
        setSelectedId((currentId) => currentId || mapped[0].id);
      }
    } catch (err) {
      console.error(err);
      setError(err.message || "Failed to load conversations.");
    } finally {
      setLoading(false);
    }
  }, []);

  // Load metrics
  const loadMetrics = useCallback(async () => {
    try {
      const res = await fetch("/api/metrics");
      if (res.ok) {
        const data = await res.json();
        setMetrics(data);
      }
    } catch (e) {
      console.warn("Failed to fetch metrics:", e);
    }
  }, []);

  useEffect(() => {
    loadThreads();
    loadMetrics();
  }, [loadThreads, loadMetrics]);

  // Selected Thread
  const selectedThread = threads.find((t) => t.id === selectedId);

  // Sync draft edit buffer and memo when selected thread changes
  useEffect(() => {
    if (selectedThread) {
      setDraftEditText(selectedThread.draft || "");
      setMemoDraft(selectedThread.memo || "");
      setEditingDraft(false);
      setEditingMemo(false);
      setEditingClassification(false);

      // サンプル復元 & start timer for current thread
      setStopwatchSeconds(0);
      setStopwatchActive(true);
    }
  }, [selectedId]);

  // Stopwatch effect
  useEffect(() => {
    if (stopwatchActive) {
      timerRef.current = setInterval(() => {
        setStopwatchSeconds((s) => s + 1);
      }, 1000);
    } else {
      clearInterval(timerRef.current);
    }
    return () => clearInterval(timerRef.current);
  }, [stopwatchActive]);

  // Filtered threads
  const filteredThreads = useMemo(() => {
    return threads.filter((thread) => {
      const matchesFilter = filter === "All" || thread.status === filter;
      const matchesChannel =
        channelFilter === "All" || thread.channel.toLowerCase() === channelFilter.toLowerCase();

      const query = search.toLowerCase();
      const matchesSearch =
        !query ||
        thread.name.toLowerCase().includes(query) ||
        thread.handle.toLowerCase().includes(query) ||
        thread.category.toLowerCase().includes(query) ||
        thread.memo.toLowerCase().includes(query) ||
        thread.messages.some((m) => m.text.toLowerCase().includes(query));

      return matchesFilter && matchesChannel && matchesSearch;
    });
  }, [threads, filter, channelFilter, search]);

  function updateLocalThread(id, changes) {
    setThreads((current) =>
      current.map((t) => (t.id === id ? { ...t, ...changes } : t))
    );
  }

  // Record elapsed stopwatch time to server
  async function recordCurrentTime() {
    if (stopwatchSeconds > 0 && selectedId) {
      try {
        await fetch(`/api/threads/${selectedId}/action`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "record_time", seconds: stopwatchSeconds }),
        });
        updateLocalThread(selectedId, {
          handlingTimeSeconds: (selectedThread?.handlingTimeSeconds || 0) + stopwatchSeconds,
        });
        setStopwatchSeconds(0);
        loadMetrics();
      } catch (e) {
        console.warn("Time recording error:", e);
      }
    }
  }

  // Workflow actions
  async function performAction(actionName, changes = {}) {
    if (!selectedId) return null;
    await recordCurrentTime();

    try {
      const res = await fetch(`/api/threads/${selectedId}/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: actionName,
          ...changes,
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Failed action: ${actionName}`);

      const mapped = mapThread(data.thread);
      updateLocalThread(selectedId, mapped);
      notify(`操作を適用しました：${actionName.replace("_", " ")}`);
      loadMetrics();
      return mapped;
    } catch (err) {
      console.error(err);
      notify(`エラー：${err.message}`);
      return null;
    }
  }

  // Approve
  async function handleApprove() {
    const textToApprove = editingDraft ? draftEditText : selectedThread?.draft;
    await performAction("approve", { draft: textToApprove });
    setEditingDraft(false);
  }

  // 保存 Draft Edit
  async function handleSaveDraftEdit() {
    await performAction("save_draft", { draft: draftEditText });
    setEditingDraft(false);
  }

  // Re-run AI Triage on this thread
  async function handleRerunTriage() {
    if (!selectedId) return;
    try {
      setIsTriaging(true);
      const res = await fetch(`/api/threads/${selectedId}/triage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tone: customTone }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Triage failed");
      const mapped = mapThread(data.thread);
      updateLocalThread(selectedId, mapped);
      notify("AI振り分けが完了しました（ルール → AI → 安全チェック）");
      loadMetrics();
    } catch (err) {
      notify(`振り分けエラー：${err.message}`);
    } finally {
      setIsTriaging(false);
    }
  }

  // Regenerate draft with custom instructions
  async function handleRegenerateDraft() {
    if (!selectedId) return;
    try {
      setIsRegenerating(true);
      const res = await fetch(`/api/threads/${selectedId}/generate-draft`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          promptGuidance: customGuidance,
          tone: customTone,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Draft generation failed");
      const mapped = mapThread(data.thread);
      updateLocalThread(selectedId, mapped);
      setDraftEditText(mapped.draft);
      setCustomGuidance("");
      notify(
        !data.gatePassed
          ? `安全チェックで要確認：${data.reason || "内容を確認してください"}`
          : data.source === "gemini"
            ? "Gemini AIで返信案を生成しました。送信前に内容を確認してください。"
            : "AIサービスを利用できないため、テンプレート案を作成しました。必ず内容を確認してください。"
      );
      loadMetrics();
    } catch (err) {
      notify(`返信案の生成エラー：${err.message}`);
    } finally {
      setIsRegenerating(false);
    }
  }

  // 保存 Contact Memo
  async function handleSaveMemo() {
    if (!selectedId) return;
    try {
      const res = await fetch(`/api/threads/${selectedId}/memo`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ memo: memoDraft }),
      });
      if (res.ok) {
        updateLocalThread(selectedId, { memo: memoDraft });
        setEditingMemo(false);
        notify("連絡先メモを保存しました");
      }
    } catch {
      notify("連絡先メモを保存できませんでした");
    }
  }

  // 保存 Classification Override
  async function handleSaveClassification() {
    if (!selectedId) return;
    try {
      const res = await fetch(`/api/threads/${selectedId}/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update_classification",
          classification: classificationDraft,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Update failed");
      updateLocalThread(selectedId, mapThread(data.thread));
      setEditingClassification(false);
      notify("分類の修正を保存しました");
      loadMetrics();
    } catch (err) {
      notify(`分類の更新に失敗しました：${err.message}`);
    }
  }

  // Rate Draft Quality
  async function handleRateDraft(rating) {
    await performAction("rate_draft", { rating });
    notify(`返信案を評価しました：${rating === "helpful" ? "良好 👍" : rating === "minor_edit" ? "軽微な修正が必要 ✏️" : "要修正 👎"}`);
  }

  // Batch triage all pending
  async function handleBatchTriage() {
    try {
      notify("未処理の会話を一括で振り分けています...");
      const res = await fetch("/api/triage-all", { method: "POST" });
      const data = await res.json();
      if (res.ok) {
        notify(`一括振り分けが完了しました：${data.triagedCount}件`);
        loadThreads();
        loadMetrics();
      }
    } catch {
      notify("一括振り分けに失敗しました");
    }
  }

  // サンプル復元 to benchmark sample data
  async function handleResetSamples() {
    try {
      const res = await fetch("/api/reset-samples", { method: "POST" });
      const data = await res.json();
      if (res.ok) {
        const mapped = data.threads.map(mapThread);
        setThreads(mapped);
        if (mapped.length > 0) setSelectedId(mapped[0].id);
        notify("初期サンプル会話を復元しました");
        loadMetrics();
      }
    } catch {
      notify("サンプルデータを復元できませんでした");
    }
  }

  // JSONをインポート File
  async function handleImportJson(event) {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed.threads)) {
        throw new Error("JSONにthreads配列が必要です。");
      }

      const res = await fetch("/api/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Import failed");

      notify(`インポート完了：${data.added}件追加、${data.updated}件更新しました。`);
      loadThreads();
      loadMetrics();
    } catch (err) {
      notify(`インポートエラー：${err.message}`);
    } finally {
      event.target.value = "";
    }
  }

  // Create Simulated Reply
  async function handleCreateSimulatedReply(e) {
    e.preventDefault();
    if (!newSimMsg.messageText.trim()) return;

    try {
      const res = await fetch("/api/threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(newSimMsg),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to create thread");

      const mapped = mapThread(data.thread);
      setThreads((current) => [mapped, ...current]);
      setSelectedId(mapped.id);
      setShowSimulateModal(false);
      setNewSimMsg({
        contactName: "",
        handle: "",
        platform: "x",
        account: "アウトリーチ担当",
        memo: "",
        messageText: "",
      });
      notify("テスト用の受信メッセージを追加し、振り分けました");
      loadMetrics();
    } catch (err) {
      notify(`メッセージの追加に失敗しました：${err.message}`);
    }
  }

  return (
    <div className="app-shell">
      {/* TOPBAR */}
      <header className="topbar">
        <div>
          <div className="eyebrow">AIを活用したアウトリーチ返信管理</div>
          <h1>アウトリーチ返信管理 MVP</h1>
        </div>

        {/* View Switch Tabs */}
        <div className="topbar-center">
          <button
            className={`tab-btn ${activeTab === "inbox" ? "active" : ""}`}
            onClick={() => setActiveTab("inbox")}
          >
            <Inbox size={15} />
            受信箱・振り分け
          </button>
          <button
            className={`tab-btn ${activeTab === "metrics" ? "active" : ""}`}
            onClick={() => {
              setActiveTab("metrics");
              loadMetrics();
            }}
          >
            <BarChart3 size={15} />
            5日間の検証・ベンチマーク
          </button>
          <button
            className={`tab-btn ${activeTab === "criteria" ? "active" : ""}`}
            onClick={() => setActiveTab("criteria")}
          >
            <BookOpen size={15} />
            判定基準・ルールガイド
          </button>
        </div>

        {/* Status Notification Banner */}
        {notification && (
          <div
            style={{
              background: "#e6f4ea",
              color: "#137333",
              padding: "6px 14px",
              borderRadius: "6px",
              fontSize: "13px",
              fontWeight: 500,
              boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
            }}
          >
            {notification}
          </div>
        )}

        {/* Topbar Actions */}
        <div className="topbar-right">
          <button
            className="secondary-button"
            title="受信メッセージをシミュレーション"
            onClick={() => setShowSimulateModal(true)}
          >
            <PlusCircle size={15} />
            受信メッセージを追加
          </button>

          <label className="secondary-button import-button" title="JSONデータをインポート">
            <Upload size={15} />
            JSONをインポート
            <input type="file" accept=".json,application/json" onChange={handleImportJson} hidden />
          </label>

          <a
            href="/api/export"
            download="outreach-threads.json"
            className="secondary-button"
            style={{ textDecoration: "none", color: "inherit", display: "flex", alignItems: "center", gap: "6px" }}
            title="JSON形式でエクスポート"
          >
            <Download size={15} />
            JSONをエクスポート
          </a>

          <a
            href="/api/export/csv"
            download="outreach-threads.csv"
            className="secondary-button"
            style={{ textDecoration: "none", color: "inherit", display: "flex", alignItems: "center", gap: "6px" }}
            title="CSV形式でエクスポート"
          >
            <Download size={15} />
            Export CSV
          </a>

          <div className="status-dot" title="担当者による確認・承認が必要です" />
          <span style={{ fontSize: "12px", color: "#64748b" }}>担当者による確認が有効</span>
        </div>
      </header>

      {/* VIEW 1: INBOX & TRIAGE */}
      {activeTab === "inbox" && (
        loading ? (
          <div style={{ display: "grid", placeItems: "center", height: "calc(100vh - 78px)", color: "#64748b" }}>
            会話を読み込み中...
          </div>
        ) : error ? (
          <div style={{ padding: "40px", textAlign: "center", color: "#dc2626" }}>
            会話の読み込みに失敗しました：{error}
          </div>
        ) : (
          <main className="workspace">
          {/* SIDEBAR */}
          <aside className="sidebar">
            <div className="sidebar-heading">
              <div>
                <h2>受信箱</h2>
                <span>
                  {threads.length}件中 {filteredThreads.length}件を表示
                </span>
              </div>
              <div style={{ display: "flex", gap: "6px" }}>
                <button
                  className="secondary-button"
                  style={{ padding: "4px 8px", fontSize: "11px" }}
                  onClick={handleBatchTriage}
                  title="未処理の会話をルールとAIで振り分け"
                >
                  <RefreshCw size={12} />
                  すべてを振り分け
                </button>
                <button
                  className="secondary-button"
                  style={{ padding: "4px 8px", fontSize: "11px" }}
                  onClick={handleResetSamples}
                  title="ベンチマーク用のサンプル会話を復元"
                >
                  <RotateCcw size={12} />
                  サンプル復元
                </button>
              </div>
            </div>

            {/* Search */}
            <div className="search-box">
              <Search size={16} />
              <input
                placeholder="連絡先・メッセージ・メモを検索..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>

            {/* Channel filter pills */}
            <div style={{ padding: "0 18px 10px", display: "flex", gap: "5px", alignItems: "center" }}>
              <span style={{ fontSize: "11px", color: "#64748b", fontWeight: 600 }}>チャネル:</span>
              {CHANNELS.map((ch) => (
                <button
                  key={ch}
                  className={`filter ${channelFilter.toLowerCase() === ch.toLowerCase() ? "active" : ""}`}
                  onClick={() => setChannelFilter(ch)}
                  style={{ padding: "3px 8px", textTransform: "capitalize" }}
                >
                  {ch === "All" ? "すべて" : ch === "x" ? "X（旧Twitter）" : ch === "linkedin" ? "LinkedIn" : "メール"}
                </button>
              ))}
            </div>

            {/* Status filters */}
            <div className="filters">
              {STATUS_FILTERS.map((s) => (
                <button
                  key={s}
                  className={`filter ${filter === s ? "active" : ""}`}
                  onClick={() => setFilter(s)}
                >
                  {getStatusLabel(s)}
                </button>
              ))}
            </div>

            {/* Thread list */}
            <div className="thread-list">
              {filteredThreads.length === 0 ? (
                <div style={{ padding: "32px 20px", textAlign: "center", color: "#94a3b8", fontSize: "13px" }}>
                  選択した条件に一致する会話はありません。
                </div>
              ) : (
                filteredThreads.map((thread) => {
                  const lastMsg = thread.messages[thread.messages.length - 1];
                  return (
                    <button
                      key={thread.id}
                      className={`thread-card ${selectedId === thread.id ? "selected" : ""}`}
                      onClick={() => setSelectedId(thread.id)}
                    >
                      <div className="thread-top">
                        <strong style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                          {thread.name}
                          <span className={`channel-pill ${thread.channel.toLowerCase()}`}>
                            {thread.channel}
                          </span>
                        </strong>
                        <span>{lastMsg?.time?.slice(11, 16) || ""}</span>
                      </div>

                      <div className="thread-meta">
                        <span className={`action-pill ${thread.action}`}>
                          {getActionLabel(thread.action)}
                        </span>
                        <span>{thread.category}</span>
                      </div>

                      <p>{lastMsg?.text || "（メッセージ本文なし）"}</p>

                      <div className="thread-bottom">
                        <span className={`badge ${getStatusClass(thread.status)}`}>
                          {getStatusLabel(thread.status)}
                        </span>
                        <ChevronRight size={14} />
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </aside>

          {/* MAIN CONVERSATION WORKSPACE */}
          {selectedThread ? (
            <section className="conversation">
              {/* Header */}
              <div className="conversation-header">
                <div className="person">
                  <div className="person-avatar">
                    <User size={18} />
                  </div>
                  <div>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                      <h2>{selectedThread.name}</h2>
                      <span className={`channel-pill ${selectedThread.channel.toLowerCase()}`}>
                        {selectedThread.channel} ({selectedThread.account})
                      </span>
                    </div>
                    <p>
                      {selectedThread.handle}
                      {selectedThread.profileUrl && ` · ${selectedThread.profileUrl}`}
                    </p>
                  </div>
                </div>

                {/* Right controls: Stopwatch & Status badge */}
                <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                  <div className="timer-box" title="この返信の確認にかかった時間">
                    <Timer size={14} color="#0284c7" />
                    <span>経過時間: {formatDuration(stopwatchSeconds)}</span>
                    <button
                      onClick={() => setStopwatchActive(!stopwatchActive)}
                      style={{ border: 0, background: "transparent", padding: 0, color: "#64748b", cursor: "pointer" }}
                      title={stopwatchActive ? "タイマーを一時停止" : "タイマーを再開"}
                    >
                      {stopwatchActive ? <Pause size={12} /> : <Play size={12} />}
                    </button>
                  </div>

                  <span className={`badge ${getStatusClass(selectedThread.status)}`}>
                    {getStatusLabel(selectedThread.status)}
                  </span>
                </div>
              </div>

              {/* Context / Internal Memo Box */}
              <div style={{ padding: "0 32px 14px", background: "#fff", borderBottom: "1px solid #e4e8ed" }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <span style={{ fontSize: "11px", fontWeight: 700, color: "#64748b" }}>
                    内部情報・メモ
                  </span>
                  {!editingMemo && (
                    <button
                      className="secondary-button"
                      style={{ padding: "2px 8px", fontSize: "11px" }}
                      onClick={() => {
                        setMemoDraft(selectedThread.memo);
                        setEditingMemo(true);
                      }}
                    >
                      <Pencil size={11} />
                      メモを編集
                    </button>
                  )}
                </div>

                {editingMemo ? (
                  <div style={{ marginTop: "6px", display: "flex", gap: "8px" }}>
                    <input
                      style={{
                        flex: 1,
                        padding: "6px 10px",
                        border: "1px solid #cbd5e1",
                        borderRadius: "6px",
                        fontSize: "12px",
                      }}
                      placeholder="連絡先の背景や会話のメモを入力..."
                      value={memoDraft}
                      onChange={(e) => setMemoDraft(e.target.value)}
                    />
                    <button className="primary-button" style={{ padding: "6px 12px", fontSize: "12px" }} onClick={handleSaveMemo}>
                      <Check size={12} />
                      保存
                    </button>
                    <button className="secondary-button" style={{ padding: "6px 10px", fontSize: "12px" }} onClick={() => setEditingMemo(false)}>
                      キャンセル
                    </button>
                  </div>
                ) : (
                  <div className="contact-memo-box">
                    {selectedThread.memo || "内部メモはありません。「メモを編集」から背景情報を記録できます。"}
                  </div>
                )}
              </div>

              {/* Conversation Messages & Decision Panel */}
              <div className="conversation-body">
                {/* Left: Chat history */}
                <div className="messages">
                  <div className="section-label">会話履歴</div>

                  {selectedThread.messages.map((message, idx) => (
                    <div key={idx} className={message.fromMe ? "message mine" : "message received"}>
                      <div className="message-author">{message.fromMe ? "自分" : selectedThread.name}</div>
                      <div className="message-bubble">{message.text}</div>
                      <div className="message-time">{message.time?.slice(11, 16) || message.time}</div>
                    </div>
                  ))}
                </div>

                {/* Right: AI Decision & Human Review Panel */}
                <div className="right-panel">
                  {/* CARD 1: CLASSIFICATION */}
                  <div className="panel">
                    <div className="panel-header">
                      <div>
                        <div className="section-label">AI処理フロー</div>
                        <h3>分類結果</h3>
                      </div>
                      <Sparkles size={18} color="#7c3aed" />
                    </div>

                    {editingClassification ? (
                      /* Classification Edit Form */
                      <div style={{ marginTop: "12px" }}>
                        <div className="reason">
                          <span>対応方針</span>
                          <select
                            className="draft-editor"
                            style={{ minHeight: "auto", height: "36px", padding: "4px 8px" }}
                            value={classificationDraft.action}
                            onChange={(e) =>
                              setClassificationDraft((prev) => ({ ...prev, action: e.target.value }))
                            }
                          >
                            {CLASSIFICATION_ACTIONS.map((opt) => (
                              <option key={opt.value} value={opt.value}>
                                {opt.label}
                              </option>
                            ))}
                          </select>
                        </div>

                        <div className="reason" style={{ marginTop: "8px" }}>
                          <span>分類カテゴリ</span>
                          <select
                            className="draft-editor"
                            style={{ minHeight: "auto", height: "36px", padding: "4px 8px" }}
                            value={classificationDraft.category}
                            onChange={(e) =>
                              setClassificationDraft((prev) => ({ ...prev, category: e.target.value }))
                            }
                          >
                            {CLASSIFICATION_CATEGORIES.map((cat) => (
                              <option key={cat} value={cat}>
                                {cat}
                              </option>
                            ))}
                          </select>
                        </div>

                        <div className="reason" style={{ marginTop: "8px" }}>
                          <span>理由</span>
                          <textarea
                            className="draft-editor"
                            style={{ minHeight: "70px" }}
                            value={classificationDraft.reason}
                            onChange={(e) =>
                              setClassificationDraft((prev) => ({ ...prev, reason: e.target.value }))
                            }
                            placeholder="分類理由を入力..."
                          />
                        </div>

                        <div className="draft-actions">
                          <button className="secondary-button" onClick={() => setEditingClassification(false)}>
                            キャンセル
                          </button>
                          <button className="primary-button" onClick={handleSaveClassification}>
                            <Check size={14} />
                            保存 Override
                          </button>
                        </div>
                      </div>
                    ) : (
                      /* Classification Summary */
                      <>
                        <div className="classification">
                          <span>対応方針</span>
                          <strong className={`action-${selectedThread.action}`}>
                            {selectedThread.action === "auto"
                              ? "AI返信案を作成"
                              : selectedThread.action === "escalate"
                              ? "担当者による確認"
                              : selectedThread.action === "skip"
                              ? "返信不要"
                              : "未分類"}
                          </strong>
                        </div>

                        <div className="classification">
                          <span>分類カテゴリ</span>
                          <strong>{selectedThread.category}</strong>
                        </div>

                        <div className="reason">
                          <span>理由・判断根拠</span>
                          <p>{selectedThread.reason}</p>
                        </div>

                        {selectedThread.ruleHit && (
                          <div className="reason">
                            <span>適用された機械ルール</span>
                            <p style={{ color: "#b45309", fontWeight: 600 }}>{selectedThread.ruleHit}</p>
                          </div>
                        )}

                        <div className="reason">
                          <span>判断元</span>
                          <p>
                            {selectedThread.decidedBy === "rule"
                              ? "機械ルール（正規表現フィルター）"
                              : selectedThread.decidedBy === "llm"
                              ? "生成AI（Gemini）"
                              : selectedThread.decidedBy === "human"
                              ? "担当者による手動修正"
                              : "振り分け処理"}
                          </p>
                        </div>

                        {selectedThread.status !== "Completed" && (
                          <div style={{ display: "flex", gap: "8px", marginTop: "12px" }}>
                            <button
                              className="secondary-button full"
                              onClick={() => {
                                setClassificationDraft({
                                  action: selectedThread.action,
                                  category: selectedThread.category,
                                  reason: selectedThread.reason,
                                });
                                setEditingClassification(true);
                              }}
                            >
                              <Pencil size={14} />
                              分類を修正
                            </button>

                            <button
                              className="secondary-button"
                              title="機械ルールとAIで再振り分け"
                              disabled={isTriaging}
                              onClick={handleRerunTriage}
                            >
                              <RefreshCw size={14} className={isTriaging ? "animate-spin" : ""} />
                              {isTriaging ? "振り分け中..." : "再振り分け"}
                            </button>
                          </div>
                        )}
                      </>
                    )}
                  </div>

                  {/* CARD 2: SAFETY CONTENT GATE */}
                  {selectedThread.gate && selectedThread.gate !== "-" && (
                    <div
                      className={`gate-box ${
                        selectedThread.gate.includes("合格") ? "passed" : "warning"
                      }`}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: "6px", fontWeight: 700 }}>
                        {selectedThread.gate.includes("合格") ? (
                          <ShieldCheck size={16} />
                        ) : (
                          <ShieldAlert size={16} />
                        )}
                        <span>内容の安全チェック：{selectedThread.gate}</span>
                      </div>
                      <span style={{ fontSize: "11px" }}>
                        {selectedThread.gate.includes("合格")
                          ? "✓ 不適切な納品約束、日程の確約、料金提示、無効なリンクがないことを確認しました。"
                          : "⚠️ 返信案に約束や条件が含まれる可能性があります。担当者が必ず確認してください。"}
                      </span>
                    </div>
                  )}

                  {/* CARD 3: REPLY DRAFT & WORKFLOW ACTIONS */}
                  {selectedThread.status === "Completed" ? (
                    <div className="panel completion-panel">
                      <div className="completion-icon"><Check size={22} /></div>
                      <h3>対応完了</h3>
                      <p>この会話は完了として記録されました。外部サービスへのメッセージ送信は行っていません。</p>
                    </div>
                  ) : selectedThread.action === "skip" ? (
                    <div className="panel empty-draft">
                      <Clock3 size={24} />
                      <h3>返信不要</h3>
                      <p>
                        この会話は返信不要と判定されました
                        （例：スパム、一斉広告、外部サービスのリンクのみ）
                      </p>
                      <div style={{ marginTop: "16px", display: "flex", justifyContent: "center", gap: "8px" }}>
                        <button
                          className="secondary-button"
                          onClick={() => {
                            setClassificationDraft({
                              action: "auto",
                              category: "カジュアルな質問",
                              reason: "担当者が返信不要の判定を変更しました",
                            });
                            setEditingClassification(true);
                          }}
                        >
                          <Pencil size={14} />
                          返信が必要に変更
                        </button>
                        <button className="primary-button" onClick={() => performAction("complete")}>
                          <Check size={14} />
                          返信不要として完了
                        </button>
                      </div>
                    </div>
                  ) : selectedThread.action === "escalate" ? (
                    <div className="panel escalation-panel">
                      <div className="panel-header">
                        <div>
                          <div className="section-label">担当者による確認が必要</div>
                          <h3>担当者の判断が必要です</h3>
                        </div>
                        <User size={18} color="#b45309" />
                      </div>

                      <div className="escalation-message">
                        <strong>この会話は安全のため自動返信を停止しています。</strong>
                        <p>
                          理由：{selectedThread.reason}。ルールまたはAIが次の内容を検出しました：
                          個別条件、日程、料金、または人間関係に関わる内容。
                        </p>
                      </div>

                      {/* Manual Response Composer */}
                      <div style={{ marginTop: "14px" }}>
                        <div className="section-label">担当者が返信を作成</div>
                        <textarea
                          className="draft-editor"
                          style={{ minHeight: "90px" }}
                          placeholder="返信文を入力するか、下のテンプレートを選択..."
                          value={draftEditText}
                          onChange={(e) => setDraftEditText(e.target.value)}
                        />

                        {/* Quick escalation templates */}
                        <div style={{ marginTop: "8px", display: "flex", gap: "6px", flexWrap: "wrap" }}>
                          <button
                            className="filter"
                            style={{ fontSize: "10px" }}
                            onClick={() =>
                              setDraftEditText(
                                "ご連絡ありがとうございます！日程の候補を確認いたしました。◯月◯日◯時でお願いいたします。当日はよろしくお願いいたします。"
                              )
                            }
                          >
                            + 日程を承諾
                          </button>
                          <button
                            className="filter"
                            style={{ fontSize: "10px" }}
                            onClick={() =>
                              setDraftEditText(
                                "ご提案ありがとうございます。大変魅力的なお話ですが、現時点では体制の都合上一旦見送りとさせていただけますと幸いです。また機会がありましたらよろしくお願いいたします。"
                              )
                            }
                          >
                            + 丁寧にお断り
                          </button>
                          <button
                            className="filter"
                            style={{ fontSize: "10px" }}
                            onClick={() =>
                              setDraftEditText(
                                "詳細な条件を教えてくださりありがとうございます。社内で確認の上、改めて明日中に折り返しご連絡いたします。"
                              )
                            }
                          >
                            + 条件を確認
                          </button>
                        </div>
                      </div>

                      <div className="draft-actions workflow-secondary-actions" style={{ marginTop: "14px" }}>
                        <button className="secondary-button" onClick={() => performAction("hold")}>
                          <Clock3 size={14} />
                          保留にする
                        </button>
                        <button className="secondary-button" onClick={() => performAction("return")}>
                          <RotateCcw size={14} />
                          修正のため差し戻す
                        </button>
                        {selectedThread.status === "On hold" && (
                          <button className="secondary-button" onClick={() => performAction("complete")}>
                            <Check size={14} />
                            保留から完了にする
                          </button>
                        )}
                        <button
                          className="primary-button"
                          disabled={!draftEditText.trim()}
                          onClick={() => performAction("approve", { draft: draftEditText })}
                        >
                          <Send size={14} />
                          承認して対応完了にする
                        </button>
                      </div>
                    </div>
                  ) : (
                    /* AUTO DRAFT WORKFLOW */
                    <div className="panel draft-panel">
                      <div className="panel-header">
                        <div>
                          <div className="section-label">AI返信案</div>
                          <h3>返信案</h3>
                        </div>
                        <FileText size={18} color="#2563eb" />
                      </div>

                      {/* Tone & Prompt Guidance Controls */}
                      <div
                        style={{
                          marginTop: "10px",
                          padding: "10px 12px",
                          background: "#f8fafc",
                          borderRadius: "8px",
                          border: "1px solid #e2e8f0",
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                          <span style={{ fontSize: "11px", fontWeight: 700, color: "#64748b" }}>
                            文体・再生成
                          </span>
                          <select
                            className="tone-select"
                            value={customTone}
                            onChange={(e) => setCustomTone(e.target.value)}
                          >
                            <option value="warm">親しみやすく丁寧</option>
                            <option value="professional">フォーマル・ビジネス向け</option>
                            <option value="concise">簡潔・直接的</option>
                            <option value="consultative">相談・アドバイス調</option>
                          </select>
                        </div>

                        <div style={{ marginTop: "8px", display: "flex", gap: "6px" }}>
                          <input
                            style={{
                              flex: 1,
                              padding: "5px 8px",
                              border: "1px solid #cbd5e1",
                              borderRadius: "6px",
                              fontSize: "12px",
                            }}
                            placeholder="追加指示（例：ガイドへのリンクに言及）..."
                            value={customGuidance}
                            onChange={(e) => setCustomGuidance(e.target.value)}
                          />
                          <button
                            className="secondary-button"
                            style={{ padding: "4px 10px", fontSize: "11px" }}
                            disabled={isRegenerating}
                            onClick={handleRegenerateDraft}
                          >
                            <RefreshCw size={12} className={isRegenerating ? "animate-spin" : ""} />
                            {isRegenerating ? "生成中..." : "返信案を再生成"}
                          </button>
                        </div>
                      </div>

                      {/* Draft Content / Editor */}
                      {editingDraft ? (
                        <div style={{ marginTop: "12px" }}>
                          <div className="section-label">返信内容を編集中</div>
                          <textarea
                            className="draft-editor"
                            value={draftEditText}
                            onChange={(e) => setDraftEditText(e.target.value)}
                          />
                        </div>
                      ) : (
                        <div className="draft-content">
                          {selectedThread.draft || "返信案はまだ生成されていません。下のボタンから生成してください。"}
                        </div>
                      )}

                      {/* Actions */}
                      <div className="draft-actions">
                        {editingDraft ? (
                          <>
                            <button className="secondary-button" onClick={() => setEditingDraft(false)}>
                              キャンセル
                            </button>
                            <button className="secondary-button" onClick={handleSaveDraftEdit}>
                              編集内容を保存
                            </button>
                          </>
                        ) : (
                          <button
                            className="secondary-button"
                            onClick={() => {
                              setDraftEditText(selectedThread.draft);
                              setEditingDraft(true);
                            }}
                          >
                            <Pencil size={14} />
                            返信案を編集
                          </button>
                        )}

                        <button
                          className="primary-button"
                          disabled={!String(editingDraft ? draftEditText : selectedThread.draft).trim()}
                          onClick={handleApprove}
                        >
                          <Check size={14} />
                          承認して対応完了にする
                        </button>
                      </div>

                      <div className="workflow-secondary-actions">
                        <button className="hold-button" onClick={() => performAction("return")}>
                          <RotateCcw size={13} />
                          修正のため差し戻す
                        </button>
                        <button className="hold-button" onClick={() => performAction("hold")}>
                          <Pause size={13} />
                          保留にする
                        </button>
                        {selectedThread.status === "On hold" && (
                          <button className="hold-button" onClick={() => performAction("complete")}>
                            <Check size={13} />
                            保留から完了にする
                          </button>
                        )}
                      </div>

                      {/* 5-Day Validation Feedback Rating */}
                      <div
                        style={{
                          marginTop: "16px",
                          paddingTop: "12px",
                          borderTop: "1px dashed #e2e8f0",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                        }}
                      >
                        <span style={{ fontSize: "11px", color: "#64748b", fontWeight: 600 }}>
                          返信案の評価（5日間の検証用）：
                        </span>
                        <div style={{ display: "flex", gap: "6px" }}>
                          <button
                            className={`filter ${selectedThread.qualityRating === "helpful" ? "active" : ""}`}
                            style={{ padding: "4px 8px", fontSize: "11px" }}
                            onClick={() => handleRateDraft("helpful")}
                            title="そのまま使用、または軽微な修正で使用可能"
                          >
                            <ThumbsUp size={12} /> 良好
                          </button>
                          <button
                            className={`filter ${selectedThread.qualityRating === "minor_edit" ? "active" : ""}`}
                            style={{ padding: "4px 8px", fontSize: "11px" }}
                            onClick={() => handleRateDraft("minor_edit")}
                            title="手動編集が必要"
                          >
                            <Pencil size={12} /> 編集あり
                          </button>
                          <button
                            className={`filter ${selectedThread.qualityRating === "poor" ? "active" : ""}`}
                            style={{ padding: "4px 8px", fontSize: "11px" }}
                            onClick={() => handleRateDraft("poor")}
                            title="品質が低い、または事実と異なる内容"
                          >
                            <ThumbsDown size={12} /> 要修正
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </section>
          ) : (
            <div style={{ display: "grid", placeItems: "center", height: "100%", color: "#94a3b8" }}>
              会話を選択すると詳細が表示されます。
            </div>
          )}
        </main>
        )
      )}

      {/* VIEW 2: 5-DAY VALIDATION & BENCHMARK DASHBOARD */}
      {activeTab === "metrics" && (
        <section className="metrics-view">
          <div style={{ marginBottom: "20px" }}>
            <h2>5日間のMVP検証ダッシュボード</h2>
            <p style={{ color: "#64748b", fontSize: "14px", marginTop: "4px" }}>
              返信対応時間、判断作業の削減、ベンチマークとの比較を記録します。
              21日間の手作業基準値（251件）と比較します。
            </p>
          </div>

          {metrics && (
            <>
              {/* Stat Cards */}
              <div className="metrics-hero">
                <div className="stat-card">
                  <div className="label">判断対象の合計</div>
                  <div className="value">{metrics.total}</div>
                  <div className="sub">システム内の会話数</div>
                </div>

                <div className="stat-card">
                  <div className="label">平均対応時間</div>
                  <div className="value" style={{ color: "#0284c7" }}>
                    {metrics.handlingTime.averageSecondsPerMsg == null ? "未計測" : formatDuration(metrics.handlingTime.averageSecondsPerMsg)}
                  </div>
                  <div className="sub">実測値を記録すると平均時間が表示されます。</div>
                </div>

                <div className="stat-card">
                  <div className="label">推定削減時間</div>
                  <div className="value" style={{ color: "#16a34a" }}>
                    {metrics.handlingTime.estimatedTimeSavedMinutes == null ? "—" : `${metrics.handlingTime.estimatedTimeSavedMinutes} 分`}
                  </div>
                  <div className="sub">推定値。実測時間を記録して検証してください。</div>
                </div>

                <div className="stat-card">
                  <div className="label">返信案の評価</div>
                  <div className="value" style={{ color: "#7c3aed" }}>
                    {metrics.ratings.totalRatings > 0
                      ? `${Math.round(
                          ((metrics.ratings.helpful + metrics.ratings.minorEdit) /
                            metrics.ratings.totalRatings) *
                            100
                        )}%`
                      : "—"}
                  </div>
                  <div className="sub">{metrics.ratings.totalRatings} 件の評価を収集</div>
                </div>
              </div>

              {/* Benchmark Comparison Table */}
              <div className="comparison-box">
                <h3 style={{ margin: "0 0 6px", fontSize: "16px" }}>
                  ワークフロー分布：MVPと21日間の手作業基準の比較
                </h3>
                <p style={{ margin: 0, fontSize: "13px", color: "#64748b" }}>
                  参考比較値：アウトリーチ分類251件・21日間。現在のMVPの実測結果とは区別してください。
                </p>

                <table className="comparison-table">
                  <thead>
                    <tr>
                      <th>ワークフローの判断区分</th>
                      <th>21日間の基準値（251件）</th>
                      <th>現在のMVPでの分布</th>
                      <th>目標・効果</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>
                        <strong>AI返信案を作成（自動）</strong>
                        <div style={{ fontSize: "11px", color: "#64748b" }}>
                          一般的な助言、お礼、簡単な相談
                        </div>
                      </td>
                      <td>
                        <span style={{ fontWeight: 700, color: "#1e293b" }}>30%</span> （75件）
                      </td>
                      <td>
                        <span style={{ fontWeight: 700, color: "#16a34a" }}>
                          {metrics.currentRates.autoRatePercent}%
                        </span>{" "}
                        （{metrics.counts.auto}件）
                      </td>
                      <td>
                        <span style={{ color: "#16a34a", fontWeight: 600 }}>
                          参考値：手作業約5分、支援利用時約45秒（実測値ではありません）
                        </span>
                      </td>
                    </tr>
                    <tr>
                      <td>
                        <strong>担当者の判断が必要（要確認）</strong>
                        <div style={{ fontSize: "11px", color: "#64748b" }}>
                          日程、料金、契約、苦情
                        </div>
                      </td>
                      <td>
                        <span style={{ fontWeight: 700, color: "#1e293b" }}>49%</span> （123件）
                      </td>
                      <td>
                        <span style={{ fontWeight: 700, color: "#d97706" }}>
                          {metrics.currentRates.escalateRatePercent}%
                        </span>{" "}
                        （{metrics.counts.escalate}件）
                      </td>
                      <td>
                        <span style={{ color: "#d97706", fontWeight: 600 }}>
                          AIに判断させず安全に担当者へ引き継ぎ
                        </span>
                      </td>
                    </tr>
                    <tr>
                      <td>
                        <strong>返信不要（スキップ）</strong>
                        <div style={{ fontSize: "11px", color: "#64748b" }}>
                          一斉広告、リンクのみのDM、対応終了
                        </div>
                      </td>
                      <td>
                        <span style={{ fontWeight: 700, color: "#1e293b" }}>21%</span> （53件）
                      </td>
                      <td>
                        <span style={{ fontWeight: 700, color: "#475569" }}>
                          {metrics.currentRates.skipRatePercent}%
                        </span>{" "}
                        （{metrics.counts.skip}件）
                      </td>
                      <td>
                        <span style={{ color: "#475569", fontWeight: 600 }}>
                          返信文の作成は不要
                        </span>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>

              {/* ステータス内訳 & Draft Ratings */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "20px" }}>
                <div className="comparison-box" style={{ margin: 0 }}>
                  <h3 style={{ margin: "0 0 12px", fontSize: "15px" }}>ステータス内訳</h3>
                  <div style={{ display: "flex", flexDirection: "column", gap: "10px", fontSize: "13px" }}>
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <span>完了・対応済み：</span>
                      <strong>{metrics.statusCounts.completed}</strong>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <span>返信案を生成（承認待ち）：</span>
                      <strong>{metrics.statusCounts.draftGenerated}</strong>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <span>確認が必要・エスカレーション：</span>
                      <strong>{metrics.statusCounts.needsReview}</strong>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <span>保留：</span>
                      <strong>{metrics.statusCounts.onHold}</strong>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <span>修正差し戻し：</span>
                      <strong>{metrics.statusCounts.returned}</strong>
                    </div>
                  </div>
                </div>

                <div className="comparison-box" style={{ margin: 0 }}>
                  <h3 style={{ margin: "0 0 12px", fontSize: "15px" }}>AI返信案への担当者フィードバック</h3>
                  <div style={{ display: "flex", flexDirection: "column", gap: "10px", fontSize: "13px" }}>
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <span>👍 良好（そのまま使用・軽微な修正）</span>
                      <strong style={{ color: "#16a34a" }}>{metrics.ratings.helpful}</strong>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <span>✏️ 大幅な手動修正が必要</span>
                      <strong style={{ color: "#d97706" }}>{metrics.ratings.minorEdit}</strong>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <span>👎 品質が低い・事実と異なる内容</span>
                      <strong style={{ color: "#dc2626" }}>{metrics.ratings.poor}</strong>
                    </div>
                  </div>
                  <div style={{ marginTop: "16px", paddingTop: "12px", borderTop: "1px solid #f1f5f9" }}>
                    <a
                      href="/api/export"
                      download="outreach-threads.json"
                      className="primary-button"
                      style={{ textDecoration: "none", display: "inline-flex", width: "100%", justifyContent: "center" }}
                    >
                      <Download size={15} />
                      検証レポートをJSONで出力
                    </a>
                  </div>
                </div>
              </div>
            </>
          )}
        </section>
      )}

      {/* VIEW 3: CRITERIA & RULES GUIDE */}
      {activeTab === "criteria" && (
        <section className="guide-view">
          <div style={{ marginBottom: "20px" }}>
            <h2>判定基準・振り分けルール</h2>
            <p style={{ color: "#64748b", fontSize: "14px", marginTop: "4px" }}>
              クライアント提供の判定基準、良い例・悪い例、および安全上の注意点に基づくガイドです。
               
            </p>
          </div>

          <div className="guide-card">
            <h3>処理の原則：機械ルール → AI → 内容の安全チェック</h3>
            <p>
              このシステムはAIの返信をそのまま出力しません。まず機械ルールで重要なリスクを検出し、
              AIで文脈を判断した後、生成された返信案に安全チェックを適用します。
               
            </p>
          </div>

          <div className="guide-card">
            <h3 style={{ color: "#b45309" }}>1. 担当者確認が必須のルール（例外なし）</h3>
            <p>該当した場合はAI返信案を作成せず、担当者の確認に回します。</p>
            <ul style={{ fontSize: "13px", lineHeight: "1.8", color: "#334155", marginTop: "8px" }}>
              <li>
                <strong>日程・MTGの日時:</strong> "9/14（月）13〜17時", "打診", "zoom", "meet".
                (例: 相手D)
              </li>
              <li>
                <strong>金額・条件・契約:</strong> "◯万円", "成果報酬", "固定額", "請求", "契約".
                (例: 相手E)
              </li>
              <li>
                <strong>実績の数字を聞かれている:</strong> "DL数", "ダウンロード数", "売上", "月商".
                (例: 相手F)
              </li>
              <li>
                <strong>断り・クレーム・こじれ:</strong> "見送らせてください", "苦情", "迷惑".
                (例: 相手G)
              </li>
              <li>
                <strong>知り合い・元同僚からの連絡:</strong> "お久しぶり", "元同僚".
                (※「同期設計」等の技術用語除外ガード付き)
              </li>
            </ul>
          </div>

          <div className="guide-card">
            <h3 style={{ color: "#475569" }}>2. 返信不要と判定するルール</h3>
            <ul style={{ fontSize: "13px", lineHeight: "1.8", color: "#334155", marginTop: "8px" }}>
              <li>
                <strong>業者の一斉営業:</strong> 罫線（━━━━）、▼登録はこちら、初月無料、キャンペーン定型.
                (例: 相手I)
              </li>
              <li>
                <strong>他サービスへの誘導だけ:</strong> 本文なしでLINEや外部URLのみのDM.
                (例: 相手J)
              </li>
            </ul>
          </div>

          <div className="guide-card">
            <h3 style={{ color: "#16a34a" }}>3. AI返信案の作成に適した例</h3>
            <ul style={{ fontSize: "13px", lineHeight: "1.8", color: "#334155", marginTop: "8px" }}>
              <li>
                <strong>相手A (お礼への返信):</strong> 助言への感謝のみで日程・金額なし。相槌で十分。
              </li>
              <li>
                <strong>相手B (マーケ相談):</strong>
                ゲーム公開前の相談。具体的なアドバイス（事前登録ページ、X発信）を自動生成。
              </li>
              <li>
                <strong>相手C (相談の続き):</strong> Steam版ウィッシュリストのコツを簡潔に回答。
              </li>
            </ul>
          </div>

          <div className="guide-card" style={{ borderLeft: "4px solid #dc2626" }}>
            <h3 style={{ color: "#dc2626" }}>4. 不適切な例と安全チェック（相手K）</h3>
            <p>
              <strong>事故の実例:</strong> LLMが「LPの初稿と合わせて形をお送りします」と
              <strong>成果物の提出を勝手に約束</strong>してしまった。
            </p>
            <p style={{ marginTop: "6px" }}>
              <strong>対策 (文面ゲート):</strong>{" "}
              AIドラフト生成後に「成果物の約束」「勝手な日時」「勝手な金額」「外部URL」が含まれていないかを自動検査し、違反時はオペレーターの目視確認に強制エスカレーションします。
            </p>
          </div>

          <div className="guide-card" style={{ borderLeft: "4px solid #d97706" }}>
            <h3 style={{ color: "#d97706" }}>5. 誤分類の境界ケース（相手H）</h3>
            <p>
              <strong>正規表現の誤爆:</strong> 「同期設計」という技術用語に「同期」ルールが反応し誤ってエスカレートしてしまった。
              本MVPのルールエンジンは技術用語ガード（「同期設計」「非同期」）を組み込み、安全性を保ちつつ手数を削減します。
            </p>
          </div>
        </section>
      )}

      {/* MODAL: SIMULATE INCOMING REPLY */}
      {showSimulateModal && (
        <div className="modal-overlay" onClick={() => setShowSimulateModal(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
              <h3 style={{ margin: 0, fontSize: "18px" }}>受信メッセージを追加</h3>
              <button
                className="secondary-button"
                style={{ padding: "4px 8px" }}
                onClick={() => setShowSimulateModal(false)}
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleCreateSimulatedReply}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px", marginBottom: "12px" }}>
                <div>
                  <label style={{ display: "block", fontSize: "11px", fontWeight: 700, color: "#64748b", marginBottom: "4px" }}>
                    連絡先名
                  </label>
                  <input
                    style={{ width: "100%", padding: "8px 10px", border: "1px solid #cbd5e1", borderRadius: "6px", fontSize: "13px" }}
                    placeholder="例：相手M（ゲームスタジオ）"
                    value={newSimMsg.contactName}
                    onChange={(e) => setNewSimMsg({ ...newSimMsg, contactName: e.target.value })}
                  />
                </div>
                <div>
                  <label style={{ display: "block", fontSize: "11px", fontWeight: 700, color: "#64748b", marginBottom: "4px" }}>
                    ハンドル名・ユーザー名
                  </label>
                  <input
                    style={{ width: "100%", padding: "8px 10px", border: "1px solid #cbd5e1", borderRadius: "6px", fontSize: "13px" }}
                    placeholder="例：@userM"
                    value={newSimMsg.handle}
                    onChange={(e) => setNewSimMsg({ ...newSimMsg, handle: e.target.value })}
                  />
                </div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px", marginBottom: "12px" }}>
                <div>
                  <label style={{ display: "block", fontSize: "11px", fontWeight: 700, color: "#64748b", marginBottom: "4px" }}>
                    連絡チャネル
                  </label>
                  <select
                    style={{ width: "100%", padding: "8px 10px", border: "1px solid #cbd5e1", borderRadius: "6px", fontSize: "13px" }}
                    value={newSimMsg.platform}
                    onChange={(e) => setNewSimMsg({ ...newSimMsg, platform: e.target.value })}
                  >
                    <option value="x">X（旧Twitter）</option>
                    <option value="linkedin">LinkedIn</option>
                    <option value="email">メール</option>
                  </select>
                </div>
                <div>
                  <label style={{ display: "block", fontSize: "11px", fontWeight: 700, color: "#64748b", marginBottom: "4px" }}>
                    使用アカウント
                  </label>
                  <input
                    style={{ width: "100%", padding: "8px 10px", border: "1px solid #cbd5e1", borderRadius: "6px", fontSize: "13px" }}
                    placeholder="例：Lily / アウトリーチ担当"
                    value={newSimMsg.account}
                    onChange={(e) => setNewSimMsg({ ...newSimMsg, account: e.target.value })}
                  />
                </div>
              </div>

              <div style={{ marginBottom: "12px" }}>
                <label style={{ display: "block", fontSize: "11px", fontWeight: 700, color: "#64748b", marginBottom: "4px" }}>
                  内部情報・メモ (OPTIONAL)
                </label>
                <input
                  style={{ width: "100%", padding: "8px 10px", border: "1px solid #cbd5e1", borderRadius: "6px", fontSize: "13px" }}
                  placeholder="例：初回の相談DM。受託の打診が進行中"
                  value={newSimMsg.memo}
                  onChange={(e) => setNewSimMsg({ ...newSimMsg, memo: e.target.value })}
                />
              </div>

              <div style={{ marginBottom: "16px" }}>
                <label style={{ display: "block", fontSize: "11px", fontWeight: 700, color: "#64748b", marginBottom: "4px" }}>
                  メッセージ本文（必須）
                </label>
                <textarea
                  style={{ width: "100%", minHeight: "100px", padding: "10px", border: "1px solid #cbd5e1", borderRadius: "6px", fontSize: "13px" }}
                  placeholder="受信したメッセージを貼り付けるか入力..."
                  required
                  value={newSimMsg.messageText}
                  onChange={(e) => setNewSimMsg({ ...newSimMsg, messageText: e.target.value })}
                />
              </div>

              <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
                <button type="button" className="secondary-button" onClick={() => setShowSimulateModal(false)}>
                  キャンセル
                </button>
                <button type="submit" className="primary-button">
                  <ArrowRight size={14} />
                  AI処理を実行して追加
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

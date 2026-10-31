import { useCallback, useEffect, useMemo, useState, useRef } from "react";
import {
  Check,
  Upload,
  ChevronDown,
  Clock3,
  Pencil,
  Search,
  Sparkles,
  RefreshCw,
  Plus,
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
  ArrowRight,
  UserRound,
  Hand,
  X,
  Database,
  EyeOff,
  Target,
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
  "挨拶・リアクションのみ",
  "会話の区切り",
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
const CHANNEL_LABELS = { All: "すべて", x: "X", linkedin: "LinkedIn", email: "メール" };

const STATUS_LABELS = {
  All: "すべて",
  New: "新着",
  "Needs review": "確認が必要",
  "Draft generated": "返信案あり",
  "On hold": "保留中",
  "Returned for revision": "差し戻し",
  Completed: "完了",
};

const ACTION_LABELS = {
  auto: "AI返信案",
  escalate: "要確認",
  skip: "返信不要",
  pending: "未分類",
};

const DECIDED_BY_LABELS = {
  rule: "機械ルール",
  llm: "生成AI（Gemini）",
  fallback: "テンプレート判定（Gemini未使用）",
  human: "担当者による修正",
  safety_gate: "安全チェック",
};

const SOURCE_LABELS = { llm: "Gemini", rule: "機械ルール", fallback: "テンプレート", unknown: "不明" };

const RATING_OPTIONS = [
  { value: "helpful", label: "そのまま使える", icon: ThumbsUp },
  { value: "minor_edit", label: "軽い修正で使える", icon: Pencil },
  { value: "poor", label: "書き直しが必要", icon: ThumbsDown },
];

const ACTION_TOASTS = {
  approve: "承認して対応完了にしました",
  save_draft: "返信案を保存しました",
  return: "修正のため差し戻しました",
  hold: "保留にしました",
  complete: "対応完了にしました",
  rate_draft: "返信案を評価しました",
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
    draftSource: draft.generator || "",
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
  if (seconds == null) return "—";
  const total = Math.round(seconds);
  if (total <= 0) return "0秒";
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  if (mins === 0) return `${secs}秒`;
  return `${mins}分${secs ? ` ${secs}秒` : ""}`;
}

function formatTime(iso) {
  return iso?.slice(11, 16) || "";
}

function initials(name) {
  return String(name || "?").replace(/^相手/, "").trim().slice(0, 2) || "?";
}

function formatPercent(value) {
  return value == null ? "—" : `${value}%`;
}

/* ------------------------------------------------------------------ */
/* Small presentational pieces                                         */
/* ------------------------------------------------------------------ */

function Avatar({ name, size = "md" }) {
  return <div className={`avatar avatar-${size}`}>{initials(name)}</div>;
}

function RatingButtons({ value, onRate }) {
  return (
    <div className="rating-row">
      <span className="rating-label">返信案の評価</span>
      <div className="rating-options">
        {RATING_OPTIONS.map(({ value: option, label, icon: Icon }) => (
          <button
            key={option}
            className={`chip-button ${value === option ? "active" : ""} rating-${option}`}
            onClick={() => onRate(option)}
          >
            <Icon size={13} />
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

function TargetBar({ value, target, direction }) {
  // direction "max": lower is better (value must stay <= target)
  const width = value == null ? 0 : Math.min(100, Math.max(0, value));
  const met = value == null ? null : direction === "max" ? value <= target : value >= target;
  return (
    <div className="target-bar">
      <div className={`target-fill ${met == null ? "" : met ? "met" : "missed"}`} style={{ width: `${width}%` }} />
      <div className="target-marker" style={{ left: `${target}%` }} title={`目標 ${target}%`} />
    </div>
  );
}

function TargetBadge({ met }) {
  if (met == null) return <span className="pill pill-muted">データ不足</span>;
  return met ? <span className="pill pill-success">目標達成</span> : <span className="pill pill-danger">目標未達</span>;
}

function DistributionBar({ segments }) {
  const total = segments.reduce((sum, s) => sum + s.value, 0);
  return (
    <div className="distribution">
      <div className="distribution-bar">
        {total === 0 ? (
          <div className="distribution-empty" />
        ) : (
          segments
            .filter((s) => s.value > 0)
            .map((s) => (
              <div
                key={s.label}
                className={`distribution-segment ${s.tone}`}
                style={{ width: `${(s.value / total) * 100}%` }}
                title={`${s.label}: ${s.value}`}
              />
            ))
        )}
      </div>
      <div className="distribution-legend">
        {segments.map((s) => (
          <div key={s.label} className="legend-item">
            <span className={`legend-dot ${s.tone}`} />
            <span>{s.label}</span>
            <strong>{s.value}</strong>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* App                                                                 */
/* ------------------------------------------------------------------ */

export default function App() {
  const [activeTab, setActiveTab] = useState("inbox"); // 'inbox', 'metrics', 'criteria'
  const [threads, setThreads] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notification, setNotification] = useState("");
  const [showDataMenu, setShowDataMenu] = useState(false);

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

  // Handling stopwatch. "manual" = baseline timing with AI output hidden.
  const [stopwatchSeconds, setStopwatchSeconds] = useState(0);
  const [stopwatchActive, setStopwatchActive] = useState(false);
  const [timingMode, setTimingMode] = useState("mvp");
  const [manualNote, setManualNote] = useState("");
  const timerRef = useRef(null);
  const notifyTimer = useRef(null);

  const notify = (msg) => {
    setNotification(msg);
    clearTimeout(notifyTimer.current);
    notifyTimer.current = setTimeout(() => setNotification(""), 4500);
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

  const selectedThread = threads.find((t) => t.id === selectedId);

  // Sync draft edit buffer and memo when selected thread changes
  useEffect(() => {
    if (selectedThread) {
      setDraftEditText(selectedThread.draft || "");
      setMemoDraft(selectedThread.memo || "");
      setEditingDraft(false);
      setEditingMemo(false);
      setEditingClassification(false);
      setManualNote("");

      // Restart the handling timer for the newly selected thread
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

  const statusCounts = useMemo(() => {
    const counts = {};
    for (const t of threads) counts[t.status] = (counts[t.status] || 0) + 1;
    counts.All = threads.length;
    return counts;
  }, [threads]);

  function updateLocalThread(id, changes) {
    setThreads((current) =>
      current.map((t) => (t.id === id ? { ...t, ...changes } : t))
    );
  }

  // Record elapsed stopwatch time to server
  async function recordCurrentTime(mode = "mvp") {
    if (stopwatchSeconds > 0 && selectedId) {
      try {
        await fetch(`/api/threads/${selectedId}/action`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "record_time", seconds: stopwatchSeconds, mode }),
        });
        if (mode === "mvp") {
          updateLocalThread(selectedId, {
            handlingTimeSeconds: (selectedThread?.handlingTimeSeconds || 0) + stopwatchSeconds,
          });
        }
        setStopwatchSeconds(0);
        loadMetrics();
      } catch (e) {
        console.warn("Time recording error:", e);
      }
    }
  }

  function startManualBaseline() {
    setTimingMode("manual");
    setStopwatchSeconds(0);
    setStopwatchActive(true);
    setManualNote("");
  }

  async function finishManualBaseline() {
    const seconds = stopwatchSeconds;
    await recordCurrentTime("manual");
    setTimingMode("mvp");
    setManualNote("");
    setStopwatchSeconds(0);
    setStopwatchActive(true);
    notify(`手作業の基準時間を記録しました（${formatDuration(seconds)}）`);
  }

  function cancelManualBaseline() {
    setTimingMode("mvp");
    setManualNote("");
    setStopwatchSeconds(0);
    notify("手作業の計測を中止しました（記録していません）");
  }

  // Workflow actions
  async function performAction(actionName, changes = {}) {
    if (!selectedId) return null;
    await recordCurrentTime("mvp");

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
      notify(ACTION_TOASTS[actionName] || "操作を適用しました");
      loadMetrics();
      return mapped;
    } catch (err) {
      console.error(err);
      notify(`エラー：${err.message}`);
      return null;
    }
  }

  async function handleApprove() {
    const textToApprove = editingDraft ? draftEditText : selectedThread?.draft;
    await performAction("approve", { draft: textToApprove });
    setEditingDraft(false);
  }

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
      setDraftEditText(mapped.draft);
      notify("再振り分けが完了しました");
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
            ? "Geminiで返信案を生成しました。内容を確認してください。"
            : "AIを利用できないため、テンプレート案を作成しました。必ず内容を確認してください。"
      );
      loadMetrics();
    } catch (err) {
      notify(`返信案の生成エラー：${err.message}`);
    } finally {
      setIsRegenerating(false);
    }
  }

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
        notify("メモを保存しました");
      }
    } catch {
      notify("メモを保存できませんでした");
    }
  }

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

  function openClassificationEditor(preset) {
    setClassificationDraft(
      preset || {
        action: selectedThread.action,
        category: selectedThread.category,
        reason: selectedThread.reason,
      }
    );
    setEditingClassification(true);
  }

  async function handleRateDraft(rating) {
    const label = RATING_OPTIONS.find((o) => o.value === rating)?.label || rating;
    await performAction("rate_draft", { rating });
    notify(`返信案を評価しました：${label}`);
  }

  async function handleBatchTriage() {
    try {
      notify("未処理の会話を振り分けています...");
      const res = await fetch("/api/triage-all", { method: "POST" });
      const data = await res.json();
      if (res.ok) {
        notify(`振り分けが完了しました：${data.triagedCount}件`);
        loadThreads();
        loadMetrics();
      }
    } catch {
      notify("一括振り分けに失敗しました");
    }
  }

  async function handleResetSamples() {
    setShowDataMenu(false);
    try {
      const res = await fetch("/api/reset-samples", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "reset failed");
      const mapped = data.threads.map(mapThread);
      setThreads(mapped);
      if (mapped.length > 0) setSelectedId(mapped[0].id);
      notify("サンプル会話を復元しました");
      loadMetrics();
    } catch {
      notify("サンプルデータを復元できませんでした（サーバー設定で無効化されています）");
    }
  }

  async function handleImportJson(event) {
    const file = event.target.files?.[0];
    setShowDataMenu(false);
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
      notify("受信メッセージを追加して振り分けました");
      loadMetrics();
    } catch (err) {
      notify(`メッセージの追加に失敗しました：${err.message}`);
    }
  }

  const manualDone = metrics?.handlingTime?.manualBaseline?.items ?? 0;
  const manualTarget = metrics?.handlingTime?.manualBaseline?.targetSampleSize ?? 10;
  const manualMode = timingMode === "manual";

  /* ---------------------------------------------------------------- */
  /* Right-panel sections                                              */
  /* ---------------------------------------------------------------- */

  function renderManualBaselinePanel() {
    return (
      <div className="card manual-panel">
        <div className="card-header">
          <div>
            <div className="eyebrow">手作業の基準計測</div>
            <h3>AIの結果を非表示にしています</h3>
          </div>
          <EyeOff size={18} className="icon-muted" />
        </div>
        <p className="card-text">
          MVPを使わずに対応した場合の時間を測ります。会話を読み、自分で判断と返信文の作成まで行ってから「計測を終了して記録」を押してください。
        </p>
        <textarea
          className="input textarea"
          placeholder="作業用メモ（保存されません）"
          value={manualNote}
          onChange={(e) => setManualNote(e.target.value)}
        />
        <div className="button-row end">
          <button className="btn btn-ghost" onClick={cancelManualBaseline}>
            中止
          </button>
          <button className="btn btn-primary" onClick={finishManualBaseline} disabled={stopwatchSeconds <= 0}>
            <Check size={15} />
            計測を終了して記録（{formatDuration(stopwatchSeconds)}）
          </button>
        </div>
      </div>
    );
  }

  function renderClassificationCard() {
    return (
      <div className="card">
        <div className="card-header">
          <div>
            <div className="eyebrow">AIの判定</div>
            <h3>分類結果</h3>
          </div>
          <Sparkles size={18} className="icon-accent" />
        </div>

        {editingClassification ? (
          <div className="form-stack">
            <label className="field">
              <span>対応方針</span>
              <select
                className="input"
                value={classificationDraft.action}
                onChange={(e) => setClassificationDraft((prev) => ({ ...prev, action: e.target.value }))}
              >
                {CLASSIFICATION_ACTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              <span>分類カテゴリ</span>
              <select
                className="input"
                value={classificationDraft.category}
                onChange={(e) => setClassificationDraft((prev) => ({ ...prev, category: e.target.value }))}
              >
                {!CLASSIFICATION_CATEGORIES.includes(classificationDraft.category) && classificationDraft.category && (
                  <option value={classificationDraft.category}>{classificationDraft.category}</option>
                )}
                {CLASSIFICATION_CATEGORIES.map((cat) => (
                  <option key={cat} value={cat}>
                    {cat}
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              <span>理由</span>
              <textarea
                className="input textarea"
                value={classificationDraft.reason}
                onChange={(e) => setClassificationDraft((prev) => ({ ...prev, reason: e.target.value }))}
                placeholder="分類理由を入力..."
              />
            </label>

            <div className="button-row end">
              <button className="btn btn-ghost" onClick={() => setEditingClassification(false)}>
                キャンセル
              </button>
              <button className="btn btn-primary" onClick={handleSaveClassification}>
                <Check size={15} />
                修正を保存
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="decision-row">
              <span className={`action-tag ${selectedThread.action}`}>{getActionLabel(selectedThread.action)}</span>
              <span className="decision-category">{selectedThread.category}</span>
            </div>

            <dl className="detail-list">
              <div>
                <dt>理由</dt>
                <dd>{selectedThread.reason}</dd>
              </div>
              {selectedThread.ruleHit && (
                <div>
                  <dt>適用ルール</dt>
                  <dd className="text-warning">{selectedThread.ruleHit}</dd>
                </div>
              )}
              <div>
                <dt>判断元</dt>
                <dd>{DECIDED_BY_LABELS[selectedThread.decidedBy] || "振り分け処理"}</dd>
              </div>
            </dl>

            {selectedThread.status !== "Completed" && (
              <div className="button-row">
                <button className="btn btn-secondary grow" onClick={() => openClassificationEditor()}>
                  <Pencil size={14} />
                  分類を修正
                </button>
                <button
                  className="btn btn-secondary"
                  title="機械ルールとAIで再振り分け"
                  disabled={isTriaging}
                  onClick={handleRerunTriage}
                >
                  <RefreshCw size={14} className={isTriaging ? "spin" : ""} />
                  {isTriaging ? "振り分け中..." : "再振り分け"}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    );
  }

  function renderGate() {
    if (!selectedThread.gate || selectedThread.gate === "-") return null;
    const passed = selectedThread.gate.includes("合格");
    return (
      <div className={`gate ${passed ? "passed" : "warning"}`}>
        {passed ? <ShieldCheck size={16} /> : <ShieldAlert size={16} />}
        <div>
          <strong>安全チェック：{selectedThread.gate}</strong>
          <span>
            {passed
              ? "成果物の約束・日時・金額・外部リンクは含まれていません。"
              : "返信案に約束や条件が含まれる可能性があります。必ず確認してください。"}
          </span>
        </div>
      </div>
    );
  }

  function renderWorkflowCard() {
    if (selectedThread.status === "Completed") {
      return (
        <div className="card completion-panel">
          <div className="completion-icon">
            <Check size={22} />
          </div>
          <h3>対応完了</h3>
          <p className="card-text">
            {selectedThread.action === "skip"
              ? "返信不要として完了しました。"
              : "この会話は完了として記録されました。外部サービスへの送信は行っていません。"}
          </p>
          {selectedThread.draftGenerated && (
            <RatingButtons value={selectedThread.qualityRating} onRate={handleRateDraft} />
          )}
        </div>
      );
    }

    if (selectedThread.action === "skip") {
      return (
        <div className="card empty-draft">
          <Clock3 size={24} className="icon-muted" />
          <h3>返信不要</h3>
          <p className="card-text">営業・勧誘、リンクのみ、答える内容のないメッセージなどと判定されました。</p>
          <div className="button-row center">
            <button
              className="btn btn-secondary"
              onClick={() =>
                openClassificationEditor({
                  action: "auto",
                  category: "カジュアルな質問",
                  reason: "担当者が返信不要の判定を変更しました",
                })
              }
            >
              <Pencil size={14} />
              返信が必要に変更
            </button>
            <button className="btn btn-primary" onClick={() => performAction("complete")}>
              <Check size={14} />
              返信不要として完了
            </button>
          </div>
        </div>
      );
    }

    if (selectedThread.action === "escalate") {
      return (
        <div className="card escalation-panel">
          <div className="card-header">
            <div>
              <div className="eyebrow warning">担当者の判断が必要</div>
              <h3>自動返信を停止しています</h3>
            </div>
            <Hand size={18} className="icon-warning" />
          </div>

          <div className="callout warning">{selectedThread.reason}</div>

          <div className="field">
            <span>返信を作成</span>
            <textarea
              className="input textarea tall"
              placeholder="返信文を入力するか、テンプレートを選択..."
              value={draftEditText}
              onChange={(e) => setDraftEditText(e.target.value)}
            />
          </div>

          <div className="template-chips">
            <button
              className="chip-button"
              onClick={() =>
                setDraftEditText(
                  "ご連絡ありがとうございます！日程の候補を確認いたしました。◯月◯日◯時でお願いいたします。当日はよろしくお願いいたします。"
                )
              }
            >
              <Plus size={12} /> 日程を承諾
            </button>
            <button
              className="chip-button"
              onClick={() =>
                setDraftEditText(
                  "ご提案ありがとうございます。大変魅力的なお話ですが、現時点では体制の都合上一旦見送りとさせていただけますと幸いです。また機会がありましたらよろしくお願いいたします。"
                )
              }
            >
              <Plus size={12} /> 丁寧にお断り
            </button>
            <button
              className="chip-button"
              onClick={() =>
                setDraftEditText(
                  "詳細な条件を教えてくださりありがとうございます。社内で確認の上、改めてご連絡いたします。"
                )
              }
            >
              <Plus size={12} /> 条件を確認
            </button>
          </div>

          <div className="button-row wrap">
            <button className="btn btn-ghost" onClick={() => performAction("hold")}>
              <Pause size={14} />
              保留にする
            </button>
            <button className="btn btn-ghost" onClick={() => performAction("return")}>
              <RotateCcw size={14} />
              差し戻す
            </button>
            {selectedThread.status === "On hold" && (
              <button className="btn btn-ghost" onClick={() => performAction("complete")}>
                <Check size={14} />
                保留から完了にする
              </button>
            )}
            <button
              className="btn btn-primary grow"
              disabled={!draftEditText.trim()}
              onClick={() => performAction("approve", { draft: draftEditText })}
            >
              <Send size={14} />
              承認して完了
            </button>
          </div>
        </div>
      );
    }

    return (
      <div className="card draft-panel">
        <div className="card-header">
          <div>
            <div className="eyebrow">AI返信案</div>
            <h3>返信案</h3>
          </div>
          {selectedThread.draftSource && (
            <span className={`pill ${selectedThread.draftSource === "gemini" ? "pill-accent" : "pill-muted"}`}>
              {selectedThread.draftSource === "gemini" ? "Gemini" : "テンプレート"}
            </span>
          )}
        </div>

        {editingDraft ? (
          <textarea
            className="input textarea tall"
            value={draftEditText}
            onChange={(e) => setDraftEditText(e.target.value)}
          />
        ) : (
          <div className="draft-content">
            {selectedThread.draft || "返信案はまだありません。「再生成」で作成してください。"}
          </div>
        )}

        <div className="regen-box">
          <div className="regen-top">
            <span>文体</span>
            <select className="input compact" value={customTone} onChange={(e) => setCustomTone(e.target.value)}>
              <option value="warm">親しみやすく丁寧</option>
              <option value="professional">フォーマル</option>
              <option value="concise">簡潔</option>
              <option value="consultative">相談・アドバイス調</option>
            </select>
          </div>
          <div className="regen-input">
            <input
              className="input"
              placeholder="追加の指示（任意）"
              value={customGuidance}
              onChange={(e) => setCustomGuidance(e.target.value)}
            />
            <button className="btn btn-secondary" disabled={isRegenerating} onClick={handleRegenerateDraft}>
              <RefreshCw size={14} className={isRegenerating ? "spin" : ""} />
              {isRegenerating ? "生成中..." : "再生成"}
            </button>
          </div>
        </div>

        <div className="button-row">
          {editingDraft ? (
            <>
              <button className="btn btn-ghost" onClick={() => setEditingDraft(false)}>
                キャンセル
              </button>
              <button className="btn btn-secondary" onClick={handleSaveDraftEdit}>
                編集内容を保存
              </button>
            </>
          ) : (
            <button
              className="btn btn-secondary"
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
            className="btn btn-primary grow"
            disabled={!String(editingDraft ? draftEditText : selectedThread.draft).trim()}
            onClick={handleApprove}
          >
            <Check size={14} />
            承認して完了
          </button>
        </div>

        <div className="button-row subtle">
          <button className="btn btn-link" onClick={() => performAction("return")}>
            <RotateCcw size={13} />
            差し戻す
          </button>
          <button className="btn btn-link" onClick={() => performAction("hold")}>
            <Pause size={13} />
            保留にする
          </button>
          {selectedThread.status === "On hold" && (
            <button className="btn btn-link" onClick={() => performAction("complete")}>
              <Check size={13} />
              保留から完了にする
            </button>
          )}
        </div>

        {selectedThread.draftGenerated && (
          <RatingButtons value={selectedThread.qualityRating} onRate={handleRateDraft} />
        )}
      </div>
    );
  }

  /* ---------------------------------------------------------------- */
  /* Views                                                             */
  /* ---------------------------------------------------------------- */

  function renderInbox() {
    if (loading) return <div className="state-message">会話を読み込み中...</div>;
    if (error) return <div className="state-message error">会話の読み込みに失敗しました：{error}</div>;

    return (
      <main className="workspace">
        <aside className="sidebar">
          <div className="sidebar-heading">
            <div>
              <h2>受信箱</h2>
              <span>
                {filteredThreads.length} / {threads.length}件
              </span>
            </div>
            <button
              className="btn btn-secondary btn-sm"
              onClick={handleBatchTriage}
              title="未処理の会話をルールとAIで振り分け"
            >
              <RefreshCw size={13} />
              すべて振り分け
            </button>
          </div>

          <div className="sidebar-controls">
            <div className="search-row">
              <div className="search-box">
                <Search size={15} />
                <input
                  placeholder="連絡先・メッセージ・メモを検索"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              <select
                className="input compact"
                value={channelFilter}
                onChange={(e) => setChannelFilter(e.target.value)}
                aria-label="チャネルで絞り込み"
              >
                {CHANNELS.map((ch) => (
                  <option key={ch} value={ch}>
                    {ch === "All" ? "全チャネル" : CHANNEL_LABELS[ch]}
                  </option>
                ))}
              </select>
            </div>

            <div className="filter-row scroll">
              {STATUS_FILTERS.map((s) => (
                <button key={s} className={`filter ${filter === s ? "active" : ""}`} onClick={() => setFilter(s)}>
                  {getStatusLabel(s)}
                  <span className="filter-count">{statusCounts[s] || 0}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="thread-list">
            {filteredThreads.length === 0 ? (
              <div className="empty-list">条件に一致する会話はありません。</div>
            ) : (
              filteredThreads.map((thread) => {
                const lastMsg = thread.messages[thread.messages.length - 1];
                return (
                  <button
                    key={thread.id}
                    className={`thread-card ${selectedId === thread.id ? "selected" : ""}`}
                    onClick={() => setSelectedId(thread.id)}
                  >
                    <Avatar name={thread.name} size="sm" />
                    <div className="thread-main">
                      <div className="thread-top">
                        <strong>{thread.name}</strong>
                        <span className="thread-time">{formatTime(lastMsg?.time)}</span>
                      </div>
                      <p>{lastMsg?.text || "（メッセージ本文なし）"}</p>
                      <div className="thread-meta">
                        {/* Manual baseline timing hides every AI-derived hint. */}
                        {!manualMode && (
                          <>
                            <span className={`action-tag small ${thread.action}`}>{getActionLabel(thread.action)}</span>
                            <span className={`badge ${getStatusClass(thread.status)}`}>{getStatusLabel(thread.status)}</span>
                          </>
                        )}
                        <span className={`channel-tag ${thread.channel.toLowerCase()}`}>
                          {CHANNEL_LABELS[thread.channel] || thread.channel}
                        </span>
                      </div>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </aside>

        {selectedThread ? (
          <section className="conversation">
            <div className="conversation-header">
              <div className="person">
                <Avatar name={selectedThread.name} />
                <div className="person-text">
                  <div className="person-title">
                    <h2>{selectedThread.name}</h2>
                    <span className={`channel-tag ${selectedThread.channel.toLowerCase()}`}>
                      {CHANNEL_LABELS[selectedThread.channel] || selectedThread.channel} · {selectedThread.account}
                    </span>
                  </div>
                  <p>{selectedThread.handle}</p>
                </div>
              </div>

              <div className="header-controls">
                <div className={`timer-box ${manualMode ? "manual" : ""}`} title="この会話の対応にかかった時間">
                  <Timer size={14} />
                  <span>{manualMode ? "手作業" : "経過"} {formatDuration(stopwatchSeconds)}</span>
                  <button
                    className="icon-button"
                    onClick={() => setStopwatchActive(!stopwatchActive)}
                    title={stopwatchActive ? "タイマーを一時停止" : "タイマーを再開"}
                  >
                    {stopwatchActive ? <Pause size={12} /> : <Play size={12} />}
                  </button>
                </div>
                {!manualMode && selectedThread.status !== "Completed" && (
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={startManualBaseline}
                    title="AIの結果を隠して、手作業での対応時間を計測します"
                  >
                    <Hand size={13} />
                    手作業で計測
                    <span className="filter-count">
                      {manualDone}/{manualTarget}
                    </span>
                  </button>
                )}
                {!manualMode && (
                  <span className={`badge ${getStatusClass(selectedThread.status)}`}>
                    {getStatusLabel(selectedThread.status)}
                  </span>
                )}
              </div>
            </div>

            <div className="conversation-body">
              <div className="messages">
                <div className="memo-box">
                  <div className="memo-head">
                    <span className="eyebrow">メモ</span>
                    {!editingMemo && (
                      <button
                        className="btn btn-link"
                        onClick={() => {
                          setMemoDraft(selectedThread.memo);
                          setEditingMemo(true);
                        }}
                      >
                        <Pencil size={12} />
                        編集
                      </button>
                    )}
                  </div>
                  {editingMemo ? (
                    <div className="memo-edit">
                      <input
                        className="input"
                        placeholder="連絡先の背景や会話のメモ"
                        value={memoDraft}
                        onChange={(e) => setMemoDraft(e.target.value)}
                      />
                      <button className="btn btn-primary btn-sm" onClick={handleSaveMemo}>
                        <Check size={12} />
                        保存
                      </button>
                      <button className="btn btn-ghost btn-sm" onClick={() => setEditingMemo(false)}>
                        キャンセル
                      </button>
                    </div>
                  ) : (
                    <p className={selectedThread.memo ? "" : "muted"}>
                      {selectedThread.memo || "メモはありません。"}
                    </p>
                  )}
                </div>

                {selectedThread.messages.map((message, idx) => (
                  <div key={idx} className={message.fromMe ? "message mine" : "message received"}>
                    <div className="message-author">{message.fromMe ? "自分" : selectedThread.name}</div>
                    <div className="message-bubble">{message.text}</div>
                    <div className="message-time">{formatTime(message.time) || message.time}</div>
                  </div>
                ))}
              </div>

              <div className="right-panel">
                {manualMode ? (
                  renderManualBaselinePanel()
                ) : (
                  <>
                    {renderClassificationCard()}
                    {renderGate()}
                    {renderWorkflowCard()}
                  </>
                )}
              </div>
            </div>
          </section>
        ) : (
          <div className="state-message">会話を選択すると詳細が表示されます。</div>
        )}
      </main>
    );
  }

  function renderMetrics() {
    const correction = metrics?.correctionRate;
    const ratings = metrics?.ratings;
    const handling = metrics?.handlingTime;
    const targets = metrics?.targets || { correctionMaxPercent: 15, usabilityMinPercent: 70 };
    const transitions = Object.entries(correction?.transitions || {}).sort((a, b) => b[1] - a[1]);
    const ACTION_SHORT = { auto: "自動", escalate: "要確認", skip: "返信不要" };

    return (
      <section className="metrics-view">
        <div className="view-header">
          <div>
            <h2>検証・計測</h2>
            <p>担当者のレビュー結果から、合意した成功基準の達成状況を集計します。</p>
          </div>
          <div className="button-row">
            <button className="btn btn-secondary" onClick={loadMetrics}>
              <RefreshCw size={14} />
              更新
            </button>
            <a href="/api/export" download="outreach-threads.json" className="btn btn-primary">
              <Download size={14} />
              計測データを出力
            </a>
          </div>
        </div>

        {metrics && (
          <>
            <div className="metrics-hero">
              <div className="stat-card">
                <div className="stat-head">
                  <span className="label">分類を直した割合</span>
                  <TargetBadge met={correction?.targetMet} />
                </div>
                <div className="value">{formatPercent(correction?.ratePercent)}</div>
                <TargetBar value={correction?.ratePercent} target={targets.correctionMaxPercent} direction="max" />
                <div className="sub">
                  目標 {targets.correctionMaxPercent}%以下 · {correction?.correctedItems ?? 0} / {correction?.eligibleReviewedItems ?? 0}件
                </div>
              </div>

              <div className="stat-card">
                <div className="stat-head">
                  <span className="label">そのまま〜軽い修正で使えた割合</span>
                  <TargetBadge met={ratings?.targetMet} />
                </div>
                <div className="value">{formatPercent(ratings?.usablePercent)}</div>
                <TargetBar value={ratings?.usablePercent} target={targets.usabilityMinPercent} direction="min" />
                <div className="sub">
                  目標 {targets.usabilityMinPercent}%以上 · {(ratings?.helpful ?? 0) + (ratings?.minorEdit ?? 0)} / {ratings?.totalRatings ?? 0}件
                </div>
              </div>

              <div className="stat-card">
                <div className="stat-head">
                  <span className="label">手作業の平均時間（基準）</span>
                  {handling?.manualBaseline?.sampleComplete ? (
                    <span className="pill pill-success">10件完了</span>
                  ) : (
                    <span className="pill pill-muted">
                      {handling?.manualBaseline?.items ?? 0}/{handling?.manualBaseline?.targetSampleSize ?? 10}件
                    </span>
                  )}
                </div>
                <div className="value">{formatDuration(handling?.manualBaseline?.meanSeconds)}</div>
                <div className="sub">最初の10件を「手作業で計測」で記録します。</div>
              </div>

              <div className="stat-card">
                <div className="stat-head">
                  <span className="label">MVP利用時の平均時間</span>
                  {handling?.reductionPercent != null && handling?.manualBaseline?.sampleComplete && (
                    <span className="pill pill-accent">−{handling.reductionPercent}%</span>
                  )}
                </div>
                <div className="value">{formatDuration(handling?.mvpAssisted?.meanSeconds)}</div>
                <div className="sub">{handling?.mvpAssisted?.items ?? 0}件の実測値</div>
              </div>
            </div>

            <div className="metrics-grid">
              <div className="panel-card">
                <h3>判定元別の修正率</h3>
                <p className="card-text">どの段階の判定が直されているかを確認します。</p>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>判定元</th>
                      <th>対象</th>
                      <th>修正</th>
                      <th>修正率</th>
                    </tr>
                  </thead>
                  <tbody>
                    {["llm", "rule", "fallback"].map((source) => {
                      const row = correction?.bySource?.[source] || {};
                      return (
                        <tr key={source}>
                          <td>{SOURCE_LABELS[source]}</td>
                          <td>{row.eligibleItems ?? 0}</td>
                          <td>{row.correctedItems ?? 0}</td>
                          <td>
                            <strong>{formatPercent(row.ratePercent)}</strong>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <div className="panel-card">
                <h3>直し方の内訳</h3>
                <p className="card-text">AIの判定 → 担当者の最終判断</p>
                {transitions.length === 0 ? (
                  <div className="empty-list">まだ修正はありません。</div>
                ) : (
                  <ul className="transition-list">
                    {transitions.map(([key, count]) => {
                      const [from, to] = key.split("→");
                      return (
                        <li key={key}>
                          <span className={`action-tag small ${from}`}>{ACTION_SHORT[from] || from}</span>
                          <ArrowRight size={13} className="icon-muted" />
                          <span className={`action-tag small ${to}`}>{ACTION_SHORT[to] || to}</span>
                          <strong>{count}件</strong>
                        </li>
                      );
                    })}
                  </ul>
                )}
                {correction?.categoryOnlyChanges > 0 && (
                  <p className="footnote">カテゴリ名のみの変更 {correction.categoryOnlyChanges}件（修正には含めません）</p>
                )}
              </div>

              <div className="panel-card">
                <h3>返信案の評価</h3>
                <DistributionBar
                  segments={[
                    { label: "そのまま使える", value: ratings?.helpful ?? 0, tone: "success" },
                    { label: "軽い修正で使える", value: ratings?.minorEdit ?? 0, tone: "accent" },
                    { label: "書き直しが必要", value: ratings?.poor ?? 0, tone: "danger" },
                  ]}
                />
                <p className="footnote">
                  生成元：Gemini {metrics.draftSources?.gemini ?? 0}件 / テンプレート {metrics.draftSources?.template_fallback ?? 0}件
                </p>
              </div>

              <div className="panel-card">
                <h3>現在の振り分け</h3>
                <DistributionBar
                  segments={[
                    { label: "AI返信案", value: metrics.counts.auto, tone: "accent" },
                    { label: "要確認", value: metrics.counts.escalate, tone: "warning" },
                    { label: "返信不要", value: metrics.counts.skip, tone: "neutral" },
                  ]}
                />
                <div className="mini-stats">
                  <div>
                    <span>完了</span>
                    <strong>{metrics.statusCounts.completed}</strong>
                  </div>
                  <div>
                    <span>承認待ち</span>
                    <strong>{metrics.statusCounts.draftGenerated}</strong>
                  </div>
                  <div>
                    <span>確認が必要</span>
                    <strong>{metrics.statusCounts.needsReview}</strong>
                  </div>
                  <div>
                    <span>保留</span>
                    <strong>{metrics.statusCounts.onHold}</strong>
                  </div>
                </div>
              </div>
            </div>

            <div className="panel-card note-card">
              <Target size={18} className="icon-accent" />
              <div>
                <strong>計測の定義</strong>
                <p>
                  分類を直した割合 = AIの最初の判定（自動・要確認・返信不要）を担当者が変えた件数 ÷ レビュー済み件数。
                  返信案の評価は、最後に生成された返信案に対する評価のみを数えます。手作業の時間はAIの結果を非表示にした状態で計測します。
                </p>
              </div>
            </div>
          </>
        )}
      </section>
    );
  }

  function renderGuide() {
    return (
      <section className="guide-view">
        <div className="view-header">
          <div>
            <h2>判定基準・ルール</h2>
            <p>クライアント提供の判定基準、良い例・悪い例、安全上の注意点に基づくガイドです。</p>
          </div>
        </div>

        <div className="guide-card flow">
          <h3>処理の流れ</h3>
          <div className="flow-steps">
            <div>
              <span>1</span>
              <strong>機械ルール</strong>
              <p>返信不要と、本人判断が必須の内容を先に判定</p>
            </div>
            <ArrowRight size={16} className="icon-muted" />
            <div>
              <span>2</span>
              <strong>生成AI（Gemini）</strong>
              <p>文脈から判定し、返信案を作成</p>
            </div>
            <ArrowRight size={16} className="icon-muted" />
            <div>
              <span>3</span>
              <strong>安全チェック</strong>
              <p>約束・日時・金額・URLを検査し、違反は書き直しか確認へ</p>
            </div>
          </div>
        </div>

        <div className="guide-grid">
          <div className="guide-card tone-warning">
            <h3>担当者の判断が必須（例外なし）</h3>
            <ul>
              <li><strong>日程・MTGの日時</strong>：日程調整・候補日・ご都合の確認</li>
              <li><strong>金額・条件・契約</strong>：◯万円、成果報酬、固定額、見積・契約条件</li>
              <li><strong>実績の数字を聞かれている</strong>：DL数、売上、月商など</li>
              <li><strong>断り・クレーム・こじれ</strong>：見送り、苦情、返金</li>
              <li><strong>知り合い・元同僚</strong>：お久しぶり、元同僚（「同期設計」等の技術用語は除外）</li>
            </ul>
          </div>

          <div className="guide-card tone-neutral">
            <h3>返信不要と判定</h3>
            <ul>
              <li><strong>業者の一斉営業</strong>：罫線・▼登録はこちら・キャンペーン等の定型</li>
              <li><strong>初回の営業・勧誘</strong>：こちらから連絡していない相手からの売り込み・勧誘・スパム（料金や打ち合わせに触れていても返信不要）</li>
              <li><strong>挨拶・リアクションのみ</strong>：初回のフォロー礼・応援など答える内容がないもの</li>
              <li><strong>リンクだけのDM</strong>：URLのみ、またはリンク付きの告知のみ</li>
              <li><strong>会話の区切り</strong>：こちらの返信への「了解です」等のみ</li>
            </ul>
            <p className="footnote">見込み客からの依頼・相談、知人、進行中の会話は返信不要にしません。</p>
          </div>

          <div className="guide-card tone-success">
            <h3>AI返信案に適した例</h3>
            <ul>
              <li><strong>お礼への返信</strong>：助言へのお礼。短い相槌で十分</li>
              <li><strong>マーケ相談</strong>：公開前の相談に、事前登録ページやX発信など具体的な助言</li>
              <li><strong>相談の続き</strong>：Steamのウィッシュリストのコツを簡潔に回答</li>
            </ul>
          </div>

          <div className="guide-card tone-danger">
            <h3>不適切な例と安全チェック</h3>
            <p>
              <strong>事故の実例：</strong>AIが「LPの初稿と合わせて形をお送りします」と成果物の提出を勝手に約束した。
            </p>
            <p>
              <strong>対策：</strong>返信案に成果物の約束・日時・金額・外部URLが含まれていないかを検査し、違反時は一度だけ書き直し、それでも違反する場合は担当者の確認に回します。
            </p>
          </div>
        </div>
      </section>
    );
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">
            <Send size={16} />
          </div>
          <div>
            <h1>アウトリーチ返信管理</h1>
            <div className="brand-sub">分類・確認・返信案の作成</div>
          </div>
        </div>

        <nav className="topbar-center">
          <button className={`tab-btn ${activeTab === "inbox" ? "active" : ""}`} onClick={() => setActiveTab("inbox")}>
            <Inbox size={15} />
            受信箱
          </button>
          <button
            className={`tab-btn ${activeTab === "metrics" ? "active" : ""}`}
            onClick={() => {
              setActiveTab("metrics");
              loadMetrics();
            }}
          >
            <BarChart3 size={15} />
            検証・計測
          </button>
          <button className={`tab-btn ${activeTab === "criteria" ? "active" : ""}`} onClick={() => setActiveTab("criteria")}>
            <BookOpen size={15} />
            判定基準
          </button>
        </nav>

        <div className="topbar-right">
          <div className="menu-wrap">
            <button className="btn btn-ghost" onClick={() => setShowDataMenu((v) => !v)} aria-expanded={showDataMenu}>
              <Database size={15} />
              データ
              <ChevronDown size={14} />
            </button>
            {showDataMenu && (
              <>
                <div className="menu-backdrop" onClick={() => setShowDataMenu(false)} />
                <div className="menu">
                  <label className="menu-item" title="JSONデータをインポート">
                    <Upload size={14} />
                    JSONをインポート
                    <input type="file" accept=".json,application/json" onChange={handleImportJson} hidden />
                  </label>
                  <a className="menu-item" href="/api/export" download="outreach-threads.json" onClick={() => setShowDataMenu(false)}>
                    <Download size={14} />
                    JSONをエクスポート
                  </a>
                  <a className="menu-item" href="/api/export/csv" download="outreach-threads.csv" onClick={() => setShowDataMenu(false)}>
                    <Download size={14} />
                    CSVをエクスポート
                  </a>
                  <div className="menu-divider" />
                  <button className="menu-item" onClick={handleResetSamples} title="サンプル会話を復元">
                    <RotateCcw size={14} />
                    サンプルを復元
                  </button>
                </div>
              </>
            )}
          </div>

          <button className="btn btn-primary" onClick={() => setShowSimulateModal(true)} title="受信メッセージを追加">
            <Plus size={15} />
            受信メッセージを追加
          </button>

          <div className="review-indicator" title="送信は行いません。すべて担当者の承認が必要です">
            <UserRound size={14} />
            承認制
          </div>
        </div>
      </header>

      {activeTab === "inbox" && renderInbox()}
      {activeTab === "metrics" && renderMetrics()}
      {activeTab === "criteria" && renderGuide()}

      {notification && (
        <div className="toast" role="status">
          <Check size={15} />
          <span>{notification}</span>
        </div>
      )}

      {showSimulateModal && (
        <div className="modal-overlay" onClick={() => setShowSimulateModal(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3>受信メッセージを追加</h3>
              <button className="icon-button" onClick={() => setShowSimulateModal(false)} aria-label="閉じる">
                <X size={16} />
              </button>
            </div>

            <form onSubmit={handleCreateSimulatedReply} className="form-stack">
              <div className="form-grid">
                <label className="field">
                  <span>連絡先名</span>
                  <input
                    className="input"
                    placeholder="例：相手M"
                    value={newSimMsg.contactName}
                    onChange={(e) => setNewSimMsg({ ...newSimMsg, contactName: e.target.value })}
                  />
                </label>
                <label className="field">
                  <span>ハンドル名</span>
                  <input
                    className="input"
                    placeholder="例：@userM"
                    value={newSimMsg.handle}
                    onChange={(e) => setNewSimMsg({ ...newSimMsg, handle: e.target.value })}
                  />
                </label>
                <label className="field">
                  <span>チャネル</span>
                  <select
                    className="input"
                    value={newSimMsg.platform}
                    onChange={(e) => setNewSimMsg({ ...newSimMsg, platform: e.target.value })}
                  >
                    <option value="x">X</option>
                    <option value="linkedin">LinkedIn</option>
                    <option value="email">メール</option>
                  </select>
                </label>
                <label className="field">
                  <span>使用アカウント</span>
                  <input
                    className="input"
                    placeholder="例：アウトリーチ担当"
                    value={newSimMsg.account}
                    onChange={(e) => setNewSimMsg({ ...newSimMsg, account: e.target.value })}
                  />
                </label>
              </div>

              <label className="field">
                <span>メモ（任意）</span>
                <input
                  className="input"
                  placeholder="例：初回の相談DM"
                  value={newSimMsg.memo}
                  onChange={(e) => setNewSimMsg({ ...newSimMsg, memo: e.target.value })}
                />
              </label>

              <label className="field">
                <span>メッセージ本文</span>
                <textarea
                  className="input textarea tall"
                  placeholder="受信したメッセージを貼り付け"
                  required
                  value={newSimMsg.messageText}
                  onChange={(e) => setNewSimMsg({ ...newSimMsg, messageText: e.target.value })}
                />
              </label>

              <div className="button-row end">
                <button type="button" className="btn btn-ghost" onClick={() => setShowSimulateModal(false)}>
                  キャンセル
                </button>
                <button type="submit" className="btn btn-primary">
                  <ArrowRight size={14} />
                  振り分けて追加
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

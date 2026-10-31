import express from "express";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { triageThread, generateCustomDraft } from "./src/ai-service.mjs";
import { evaluateContentGate } from "./src/rules-engine.mjs";
import { shouldAutoTriage } from "./src/triage.mjs";
import {
  ensureOriginalClassification,
  applyHumanClassification,
  markHumanReviewed,
  prepareImportedThread,
  computeCorrectionRate,
  computeCorrectionBreakdown,
} from "./src/correction-rate.mjs";
import { summarizeHandlingTimes } from "./src/handling-time.mjs";
import {
  createApiAccessMiddleware,
  createCorsMiddleware,
  createRateLimiter,
  contentSecurityPolicy,
  isLoopbackAddress,
  parseBooleanEnv,
  parseIntegerEnv,
  parseListEnv,
  sanitizeJson,
  securityHeaders,
} from "./src/security.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const IS_PRODUCTION = process.env.NODE_ENV === "production";

// --- Configuration (all from the process environment; see README) -----------
const PORT = parseIntegerEnv(process.env.PORT, { fallback: 3000, min: 0, max: 65535 });
// Loopback by default: a server holding private conversations must not be
// reachable from the network unless the operator explicitly opts in.
const HOST = String(process.env.HOST || "127.0.0.1").trim() || "127.0.0.1";
const API_AUTH_TOKEN = process.env.API_AUTH_TOKEN || "";
const ALLOWED_ORIGINS = parseListEnv(process.env.ALLOWED_ORIGINS);
const RATE_LIMIT_PER_MINUTE = parseIntegerEnv(process.env.RATE_LIMIT_PER_MINUTE, {
  fallback: 300,
  min: 0,
});
const MAX_THREADS = parseIntegerEnv(process.env.MAX_THREADS, {
  fallback: 5000,
  min: 1,
});
const ALLOW_SAMPLE_RESET = parseBooleanEnv(process.env.ALLOW_SAMPLE_RESET);

// Fail closed: a production server exposed to the network must have an auth
// token (or sit behind an authenticating reverse proxy on loopback).
if (IS_PRODUCTION && !isLoopbackAddress(HOST) && !API_AUTH_TOKEN) {
  console.error(
    `[security] Refusing to start: NODE_ENV=production with HOST=${HOST} (non-loopback) and no API_AUTH_TOKEN. ` +
      "Set API_AUTH_TOKEN, keep HOST=127.0.0.1 behind an authenticating reverse proxy, or bind an explicit interface with a token."
  );
  process.exit(1);
}

if (!IS_PRODUCTION && !isLoopbackAddress(HOST) && !API_AUTH_TOKEN) {
  console.warn(
    `[security] Development server bound to ${HOST} without API_AUTH_TOKEN; any host that can reach this machine can read and modify conversation data.`
  );
}

const app = express();

const sampleDataPath = path.resolve(__dirname, "src/sample-threads.json");
const dataDirectory = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.resolve(__dirname, ".data");
const persistedDataPath = path.join(dataDirectory, "threads.json");

app.use(securityHeaders);
if (IS_PRODUCTION) app.use(contentSecurityPolicy);
app.use(createCorsMiddleware(ALLOWED_ORIGINS));
app.use(createRateLimiter({ max: RATE_LIMIT_PER_MINUTE }));
app.use(
  createApiAccessMiddleware({
    isProduction: IS_PRODUCTION,
    configuredToken: API_AUTH_TOKEN,
  })
);
app.use(express.json({ limit: "5mb" }));

// Shared length caps for free-text fields accepted over the API.
const LIMITS = {
  messageText: 20_000,
  draft: 20_000,
  promptGuidance: 2_000,
  memo: 2_000,
  feedback: 2_000,
  name: 200,
  handle: 200,
  platform: 50,
  account: 200,
  category: 200,
  reason: 1_000,
};
const ALLOWED_TONES = new Set(["warm", "professional", "concise", "consultative"]);
const ALLOWED_RATINGS = new Set(["helpful", "minor_edit", "poor"]);
const MAX_HANDLING_SECONDS_PER_RECORD = 86_400; // 24h: absurd values are rejected, not stored.
// "manual" = baseline timing with AI output hidden (the client's first-10 manual
// comparison); "mvp" = normal handling with the MVP's classification and draft.
const ALLOWED_TIMING_MODES = new Set(["mvp", "manual"]);
const EVALUATION_TARGETS = { correctionMaxPercent: 15, usabilityMinPercent: 70 };

function normalizeThreads(items) {
  if (!Array.isArray(items)) return [];
  // sanitizeJson deep-copies while dropping prototype-pollution keys.
  return sanitizeJson(items)
    .filter(
      (thread, index, array) =>
        thread?.thread?.id &&
        index === array.findIndex((item) => item?.thread?.id === thread.thread.id)
    )
    // Derive the original AI classification for records that still carry one
    // implicitly; never overwrites an already preserved snapshot.
    .map((thread) => ensureOriginalClassification(thread));
}

function loadSampleThreads() {
  try {
    const raw = JSON.parse(fs.readFileSync(sampleDataPath, "utf-8"));
    return normalizeThreads(raw.threads || []);
  } catch (e) {
    console.warn("Could not read sample-threads.json:", e);
    return [];
  }
}

function loadThreads() {
  try {
    if (fs.existsSync(persistedDataPath)) {
      const raw = JSON.parse(fs.readFileSync(persistedDataPath, "utf-8"));
      if (Array.isArray(raw.threads)) return normalizeThreads(raw.threads);
      console.warn("Persisted thread data had an invalid format; loading samples.");
    }
  } catch (e) {
    console.warn("Could not read persisted thread data; loading samples:", e.message);
  }
  return loadSampleThreads();
}

function persistThreads() {
  try {
    fs.mkdirSync(dataDirectory, { recursive: true });
    const tempPath = `${persistedDataPath}.tmp`;
    fs.writeFileSync(
      tempPath,
      JSON.stringify({ saved_at: new Date().toISOString(), threads }, null, 2),
      "utf-8"
    );
    fs.renameSync(tempPath, persistedDataPath);
    return true;
  } catch (e) {
    console.error("Failed to persist thread data:", e);
    return false;
  }
}

let threads = loadThreads();

// Health Check
app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "outreach-pipeline-api",
    version: "1.0.0-mvp",
    threadsCount: threads.length,
    hasGeminiKey: Boolean(process.env.GEMINI_API_KEY),
  });
});

// List all threads
app.get("/api/threads", (_req, res) => {
  res.json({
    ok: true,
    threads,
  });
});

// Get single thread
app.get("/api/threads/:id", (req, res) => {
  const thread = threads.find((item) => item.thread.id === req.params.id);
  if (!thread) {
    return res.status(404).json({
      ok: false,
      error: "Thread not found",
    });
  }
  res.json({
    ok: true,
    thread,
  });
});

// Create new thread / Simulate incoming reply
app.post("/api/threads", async (req, res) => {
  try {
    const { contactName, handle, platform, account, messageText, memo } = req.body ?? {};

    if (typeof messageText !== "string" || !messageText.trim()) {
      return res.status(400).json({ ok: false, error: "Message text is required" });
    }
    if (messageText.length > LIMITS.messageText) {
      return res.status(400).json({ ok: false, error: `Message text must be at most ${LIMITS.messageText} characters` });
    }
    if (threads.length >= MAX_THREADS) {
      return res.status(409).json({ ok: false, error: `Thread limit reached (MAX_THREADS=${MAX_THREADS}). Export or remove conversations before adding more.` });
    }
    if (
      (typeof contactName === "string" && contactName.length > LIMITS.name) ||
      (typeof handle === "string" && handle.length > LIMITS.handle) ||
      (typeof platform === "string" && platform.length > LIMITS.platform) ||
      (typeof account === "string" && account.length > LIMITS.account) ||
      (typeof memo === "string" && memo.length > LIMITS.memo)
    ) {
      return res.status(400).json({ ok: false, error: "One or more fields exceed their maximum length" });
    }

    const threadId = `th-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const newThread = {
      counterpart: {
        id: String(contactName ?? "").trim() || "New Contact",
        handle: String(handle ?? "").trim() || "@unknown",
        profile_url: "",
        memo: String(memo ?? "").trim(),
      },
      medium: {
        type: String(platform ?? "").trim() || "x",
        account: String(account ?? "").trim() || "Default Account",
      },
      thread: {
        id: threadId,
        last_incoming_at: new Date().toISOString(),
        status: "open",
      },
      messages: [
        {
          from: "counterpart",
          text: messageText.trim(),
          at: new Date().toISOString(),
        },
      ],
      classification: {
        action: "pending",
        category: "Unclassified",
        reason: "New incoming message waiting for triage",
        decided_by: "",
        rule_hit: null,
      },
      draft: {
        generated: null,
        edited: null,
        gate: "-",
        send_status: "held_for_human",
      },
      handling_time_seconds: 0,
      quality_rating: null,
    };

    // Auto-run triage on creation
    const triageResult = await triageThread(newThread);
    newThread.classification = triageResult.classification;
    ensureOriginalClassification(newThread);
    newThread.draft = triageResult.draft;

    if (triageResult.classification.action === "skip") {
      newThread.thread.status = "handled";
    } else if (triageResult.classification.action === "escalate") {
      newThread.thread.status = "needs_review";
    } else if (triageResult.draft.generated) {
      newThread.thread.status = "draft_generated";
    }

    threads.unshift(newThread);
    if (!persistThreads()) {
      threads.shift();
      return res.status(500).json({ ok: false, error: "Could not save new conversation" });
    }

    res.json({
      ok: true,
      thread: newThread,
    });
  } catch (err) {
    console.error("Create thread error:", err);
    res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

// Update contact context/memo
app.put("/api/threads/:id/memo", (req, res) => {
  const thread = threads.find((item) => item.thread.id === req.params.id);
  if (!thread) {
    return res.status(404).json({ ok: false, error: "Thread not found" });
  }

  const { memo, handle, name } = req.body ?? {};
  if (memo !== undefined && String(memo).length > LIMITS.memo) {
    return res.status(400).json({ ok: false, error: `Memo must be at most ${LIMITS.memo} characters` });
  }
  if (handle !== undefined && String(handle).length > LIMITS.handle) {
    return res.status(400).json({ ok: false, error: `Handle must be at most ${LIMITS.handle} characters` });
  }
  if (name !== undefined && String(name).length > LIMITS.name) {
    return res.status(400).json({ ok: false, error: `Contact name must be at most ${LIMITS.name} characters` });
  }
  if (memo !== undefined) thread.counterpart.memo = String(memo);
  if (handle !== undefined) thread.counterpart.handle = String(handle);
  if (name !== undefined) thread.counterpart.id = String(name);
  if (!persistThreads()) return res.status(500).json({ ok: false, error: "Could not save changes to disk" });

  res.json({
    ok: true,
    thread,
  });
});

// Run triage on specific thread
app.post("/api/threads/:id/triage", async (req, res) => {
  const thread = threads.find((item) => item.thread.id === req.params.id);
  if (!thread) {
    return res.status(404).json({ ok: false, error: "Thread not found" });
  }

  try {
    const tone = req.body?.tone || "warm";
    if (typeof tone !== "string" || !ALLOWED_TONES.has(tone)) {
      return res.status(400).json({ ok: false, error: `Invalid tone. Allowed: ${[...ALLOWED_TONES].join(", ")}` });
    }
    const result = await triageThread(thread, { tone });

    thread.classification = result.classification;
    // First AI assignment only: preserves the original AI classification so a
    // later human override cannot erase it.
    ensureOriginalClassification(thread);
    const previousGenerated = thread.draft?.generated ?? null;
    thread.draft = {
      ...thread.draft,
      generated: result.draft.generated,
      gate: result.draft.gate,
      send_status: result.draft.send_status,
      generator: result.draft.generator ?? null,
    };
    // The rating (if any) described the previous draft text.
    if ((thread.draft?.generated ?? null) !== previousGenerated) {
      thread.quality_rating = null;
      thread.quality_feedback = "";
      thread.quality_rated_at = null;
    }

    if (result.classification.action === "skip") {
      thread.thread.status = "handled";
    } else if (result.classification.action === "escalate") {
      thread.thread.status = "needs_review";
    } else if (result.draft.generated) {
      thread.thread.status = "draft_generated";
    }

    if (!persistThreads()) return res.status(500).json({ ok: false, error: "Could not save triage result" });
    res.json({
      ok: true,
      thread,
    });
  } catch (err) {
    console.error("Triage thread error:", err);
    res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

// Generate or regenerate draft with custom guidance
app.post("/api/threads/:id/generate-draft", async (req, res) => {
  const thread = threads.find((item) => item.thread.id === req.params.id);
  if (!thread) {
    return res.status(404).json({ ok: false, error: "Thread not found" });
  }

  try {
    const { promptGuidance, tone } = req.body ?? {};
    if (tone !== undefined && (typeof tone !== "string" || !ALLOWED_TONES.has(tone))) {
      return res.status(400).json({ ok: false, error: `Invalid tone. Allowed: ${[...ALLOWED_TONES].join(", ")}` });
    }
    if (promptGuidance !== undefined && (typeof promptGuidance !== "string" || promptGuidance.length > LIMITS.promptGuidance)) {
      return res.status(400).json({ ok: false, error: `Guidance must be a string of at most ${LIMITS.promptGuidance} characters` });
    }
    const result = await generateCustomDraft(thread, promptGuidance, tone);

    const previousGenerated = thread.draft?.generated ?? null;
    if (!thread.draft) thread.draft = {};
    thread.draft.generated = result.draft;
    thread.draft.generator = result.source || "unknown";
    thread.draft.gate = result.gate;
    thread.draft.send_status = "held_for_human";
    // A quality rating describes the draft that was rated. Once the generated
    // text changes, the old rating must not be attributed to the new draft.
    if ((thread.draft.generated ?? null) !== previousGenerated) {
      thread.quality_rating = null;
      thread.quality_feedback = "";
      thread.quality_rated_at = null;
    }
    if (!result.gatePassed) {
      thread.classification = {
        ...thread.classification,
        action: "escalate",
        reason: `${thread.classification?.reason || ""} (文面ゲート要確認: ${result.reason || "安全チェックに失敗しました"})`.trim(),
        decided_by: "safety_gate",
      };
      thread.thread.status = "needs_review";
    } else {
      thread.thread.status = "draft_generated";
    }

    if (!persistThreads()) return res.status(500).json({ ok: false, error: "Could not save generated draft" });
    res.json({
      ok: true,
      thread,
      gatePassed: result.gatePassed,
      reason: result.reason,
      source: result.source || "unknown",
    });
  } catch (err) {
    console.error("Generate draft error:", err);
    res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

// Batch triage on all pending/new threads
app.post("/api/triage-all", async (req, res) => {
  try {
    let triagedCount = 0;
    for (const thread of threads) {
      if (shouldAutoTriage(thread)) {
        const result = await triageThread(thread);
        const previousGenerated = thread.draft?.generated ?? null;
        thread.classification = result.classification;
        ensureOriginalClassification(thread);
        thread.draft = result.draft;
        // The rating (if any) described the previous draft text.
        if ((thread.draft?.generated ?? null) !== previousGenerated) {
          thread.quality_rating = null;
          thread.quality_feedback = "";
          thread.quality_rated_at = null;
        }
        if (result.classification.action === "skip") {
          thread.thread.status = "handled";
        } else if (result.classification.action === "escalate") {
          thread.thread.status = "needs_review";
        } else if (result.draft.generated) {
          thread.thread.status = "draft_generated";
        }
        triagedCount++;
      }
    }
    if (!persistThreads()) return res.status(500).json({ ok: false, error: "Could not save triage results" });
    res.json({
      ok: true,
      triagedCount,
      total: threads.length,
    });
  } catch (err) {
    console.error("Batch triage error:", err);
    res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

// Workflow Actions
app.post("/api/threads/:id/action", (req, res) => {
  const thread = threads.find((item) => item.thread.id === req.params.id);
  if (!thread) {
    return res.status(404).json({ ok: false, error: "Thread not found" });
  }

  const { action, draft, classification, rating, feedback, seconds, mode } = req.body ?? {};

  const approvedDraft = action === "approve"
    ? String(draft ?? thread.draft?.edited ?? thread.draft?.generated ?? "").trim()
    : "";

  if (action === "approve" && !approvedDraft) {
    return res.status(400).json({ ok: false, error: "A non-empty reply draft is required before approval" });
  }

  // Approval is a state transition, not a way around the content safety gate.
  // Validate the exact text being approved (edited text takes precedence) before
  // mutating status, draft, or review metadata.
  if (action === "approve") {
    const gateCheck = evaluateContentGate(approvedDraft);
    if (!gateCheck.passed) {
      return res.status(400).json({
        ok: false,
        error: "返信案は安全チェックを通過していません。内容を修正してから再度承認してください。",
        gate: gateCheck.gate,
        reason: gateCheck.reason,
      });
    }
  }

  if (draft !== undefined && draft !== null && String(draft).length > LIMITS.draft) {
    return res.status(400).json({ ok: false, error: `Draft must be at most ${LIMITS.draft} characters` });
  }
  if (action === "rate_draft") {
    if (rating !== undefined && rating !== null && !ALLOWED_RATINGS.has(String(rating))) {
      return res.status(400).json({ ok: false, error: `Invalid rating. Allowed: ${[...ALLOWED_RATINGS].join(", ")}` });
    }
    if (feedback !== undefined && feedback !== null && String(feedback).length > LIMITS.feedback) {
      return res.status(400).json({ ok: false, error: `Feedback must be at most ${LIMITS.feedback} characters` });
    }
  }
  if (action === "record_time") {
    if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0 || seconds > MAX_HANDLING_SECONDS_PER_RECORD) {
      return res.status(400).json({ ok: false, error: `seconds must be a number greater than 0 and at most ${MAX_HANDLING_SECONDS_PER_RECORD}` });
    }
    if (mode !== undefined && !ALLOWED_TIMING_MODES.has(mode)) {
      return res.status(400).json({ ok: false, error: `Invalid timing mode. Allowed: ${[...ALLOWED_TIMING_MODES].join(", ")}` });
    }
  }

  switch (action) {
    case "update_classification": {
      const payload = classification || {};
      const allowedActions = ["auto", "escalate", "skip"];
      if (!allowedActions.includes(payload.action)) {
        return res.status(400).json({ ok: false, error: "Invalid classification action" });
      }
      if (String(payload.category ?? "").length > LIMITS.category || String(payload.reason ?? "").length > LIMITS.reason) {
        return res.status(400).json({ ok: false, error: "Category or reason exceeds the maximum length" });
      }

      // Keeps `original_classification` intact, records the human override as the
      // current classification, and marks the item as human-reviewed.
      applyHumanClassification(thread, payload);

      if (payload.action === "escalate") {
        thread.thread.status = "needs_review";
      } else if (payload.action === "skip") {
        thread.thread.status = "handled";
        if (!thread.draft) thread.draft = {};
        thread.draft.send_status = "not_needed";
      } else if (thread.draft?.generated) {
        thread.thread.status = "draft_generated";
        if (!thread.draft) thread.draft = {};
        thread.draft.send_status = "held_for_human";
      }
      break;
    }

    case "save_draft":
      if (!thread.draft) thread.draft = {};
      thread.draft.edited = String(draft || "");
      break;

    case "approve":
      // This MVP does not connect to external messaging APIs.
      // Approval means the operator accepted the draft and marked the item complete;
      // it must never claim that a message was actually sent.
      thread.thread.status = "handled";
      if (!thread.draft) thread.draft = {};
      thread.draft.edited = approvedDraft;
      thread.draft.send_status = "approved";
      markHumanReviewed(thread, "approve");
      break;

    case "return":
      thread.thread.status = "returned_for_revision";
      if (!thread.draft) thread.draft = {};
      thread.draft.send_status = "held_for_human";
      break;

    case "hold":
      thread.thread.status = "on_hold";
      if (!thread.draft) thread.draft = {};
      thread.draft.send_status = "held_for_human";
      break;

    case "complete":
      thread.thread.status = "handled";
      markHumanReviewed(thread, "complete");
      break;

    case "rate_draft":
      thread.quality_rating = rating || null;
      thread.quality_feedback = feedback || "";
      thread.quality_rated_at = new Date().toISOString();
      break;

    case "record_time":
      // `seconds` was validated above (finite, > 0, bounded). Each record keeps
      // its own timestamp and mode so the evaluation can pick the window and
      // separate the manual baseline from MVP-assisted handling.
      if ((mode ?? "mvp") === "mvp") {
        thread.handling_time_seconds = (thread.handling_time_seconds || 0) + seconds;
      }
      if (!Array.isArray(thread.handling_time_records)) thread.handling_time_records = [];
      thread.handling_time_records.push({ seconds, mode: mode ?? "mvp", at: new Date().toISOString() });
      break;

    default:
      return res.status(400).json({ ok: false, error: "Unknown action" });
  }

  if (!persistThreads()) return res.status(500).json({ ok: false, error: "Could not save workflow changes" });
  res.json({
    ok: true,
    thread,
  });
});

// Import JSON
app.post("/api/import", (req, res) => {
  try {
    const sanitized = sanitizeJson(req.body?.threads);
    if (!Array.isArray(sanitized)) {
      return res.status(400).json({ ok: false, error: "threads must be an array" });
    }
    if (sanitized.length > MAX_THREADS) {
      return res.status(400).json({ ok: false, error: `Import exceeds the thread limit (MAX_THREADS=${MAX_THREADS})` });
    }

    const incoming = sanitized;

    const validThreads = incoming.filter((item) => {
      return (
        item &&
        item.thread &&
        item.thread.id &&
        Array.isArray(item.messages)
      );
    });

    if (validThreads.length !== incoming.length) {
      return res.status(400).json({
        ok: false,
        error: "One or more threads have an invalid structure",
      });
    }

    let added = 0;
    let updated = 0;

    // Fail before mutating anything if the merge would exceed the cap.
    const existingIds = new Set(threads.map((item) => item.thread.id));
    const newCount = validThreads.filter((item) => !existingIds.has(item.thread.id)).length;
    if (threads.length + newCount > MAX_THREADS) {
      return res.status(400).json({ ok: false, error: `Import would exceed the thread limit (MAX_THREADS=${MAX_THREADS})` });
    }

    for (const incomingThread of validThreads) {
      const existingIndex = threads.findIndex(
        (item) => item.thread.id === incomingThread.thread.id
      );

      // Keeps the preserved original AI classification and review flag for a
      // thread that already exists, and derives the original for new records
      // whose current classification is still marked as AI-assigned.
      if (existingIndex === -1) {
        threads.push(prepareImportedThread(incomingThread));
        added += 1;
      } else {
        threads[existingIndex] = prepareImportedThread(
          incomingThread,
          threads[existingIndex]
        );
        updated += 1;
      }
    }

    if (!persistThreads()) return res.status(500).json({ ok: false, error: "Could not save imported data" });
    res.json({
      ok: true,
      added,
      updated,
      total: threads.length,
    });
  } catch (error) {
    console.error("Import error:", error);
    res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

// Export JSON
app.get("/api/export", (_req, res) => {
  res.setHeader("Content-Disposition", "attachment; filename=outreach-threads.json");
  res.setHeader("Content-Type", "application/json");
  res.send(JSON.stringify({ threads, exported_at: new Date().toISOString() }, null, 2));
});

// Export CSV
app.get("/api/export/csv", (_req, res) => {
  const headers = [
    "Thread ID",
    "Contact Name",
    "Handle",
    "Channel",
    "Account",
    "Status",
    "Action",
    "Category",
    "Reason",
    "Rule Hit",
    "Decided By",
    "Original Action",
    "Original Decided By",
    "Handling Time (s)",
    "Manual Baseline Time (s)",
    "Last Message",
    "Draft Generated",
    "Draft Edited",
    "Gate",
    "Send Status",
    "Quality Rating",
    "Draft Source",
  ];

  const escapeCsv = (val) => {
    if (val === null || val === undefined) return '""';
    const str = String(val).replace(/"/g, '""');
    return `"${str}"`;
  };

  const rows = threads.map((t) => {
    const lastMsg = t.messages?.[t.messages.length - 1]?.text || "";
    return [
      escapeCsv(t.thread?.id),
      escapeCsv(t.counterpart?.id),
      escapeCsv(t.counterpart?.handle),
      escapeCsv(t.medium?.type),
      escapeCsv(t.medium?.account),
      escapeCsv(t.thread?.status),
      escapeCsv(t.classification?.action),
      escapeCsv(t.classification?.category),
      escapeCsv(t.classification?.reason),
      escapeCsv(t.classification?.rule_hit),
      escapeCsv(t.classification?.decided_by),
      escapeCsv(t.original_classification?.action || ""),
      escapeCsv(t.original_classification?.decided_by || ""),
      escapeCsv(t.handling_time_seconds || 0),
      escapeCsv(
        (Array.isArray(t.handling_time_records) ? t.handling_time_records : [])
          .filter((r) => r?.mode === "manual")
          .reduce((sum, r) => sum + (Number(r.seconds) || 0), 0)
      ),
      escapeCsv(lastMsg),
      escapeCsv(t.draft?.generated || ""),
      escapeCsv(t.draft?.edited || ""),
      escapeCsv(t.draft?.gate || ""),
      escapeCsv(t.draft?.send_status || ""),
      escapeCsv(t.quality_rating || ""),
      escapeCsv(t.draft?.generator || ""),
    ].join(",");
  });

  const csvContent = "\uFEFF" + [headers.join(","), ...rows].join("\n");
  res.setHeader("Content-Disposition", "attachment; filename=outreach-threads.csv");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.send(csvContent);
});

// Reset to Sample Threads
// Destructive: replaces every conversation with the bundled demo set.
// Disabled unless the operator explicitly starts the server with
// ALLOW_SAMPLE_RESET=true (intended for disposable instances only).
app.post("/api/reset-samples", (_req, res) => {
  if (!ALLOW_SAMPLE_RESET) {
    return res.status(403).json({
      ok: false,
      error: "Sample reset is disabled: it replaces every conversation with the demo set. Start the server with ALLOW_SAMPLE_RESET=true on a disposable instance to enable it.",
    });
  }
  threads = loadSampleThreads();
  if (!persistThreads()) return res.status(500).json({ ok: false, error: "Could not save reset data" });
  res.json({
    ok: true,
    message: "Reset to 12 sample threads",
    total: threads.length,
    threads,
  });
});

// Metrics for the evaluation dashboard
app.get("/api/metrics", (_req, res) => {
  const total = threads.length;
  const counts = { auto: 0, escalate: 0, skip: 0, unclassified: 0 };
  const decidedBy = { llm: 0, rule: 0, fallback: 0, human: 0, other: 0 };
  const statusCounts = { completed: 0, draftGenerated: 0, needsReview: 0, onHold: 0, returned: 0 };
  const ratings = { helpful: 0, minorEdit: 0, poor: 0 };
  const draftSources = { gemini: 0, template_fallback: 0 };

  for (const t of threads) {
    const act = t.classification?.action;
    if (act === "auto" || act === "escalate" || act === "skip") counts[act]++;
    else counts.unclassified++;

    const by = t.classification?.decided_by;
    if (by in decidedBy) decidedBy[by]++;
    else if (by) decidedBy.other++;

    const status = t.thread?.status;
    if (status === "handled" || t.draft?.send_status === "sent") statusCounts.completed++;
    else if (status === "on_hold") statusCounts.onHold++;
    else if (status === "returned_for_revision") statusCounts.returned++;
    else if (status === "needs_review" || act === "escalate") statusCounts.needsReview++;
    else if (status === "draft_generated" || t.draft?.generated) statusCounts.draftGenerated++;

    if (t.quality_rating === "helpful") ratings.helpful++;
    else if (t.quality_rating === "minor_edit") ratings.minorEdit++;
    else if (t.quality_rating === "poor") ratings.poor++;

    if (t.draft?.generator in draftSources) draftSources[t.draft.generator]++;
  }

  const percent = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);
  const totalRatings = ratings.helpful + ratings.minorEdit + ratings.poor;
  const usablePercent = percent(ratings.helpful + ratings.minorEdit, totalRatings);

  // Human correction rate over eligible items only:
  // original AI classification available AND human review completed.
  const correctionRate = computeCorrectionRate(threads);
  const correctionBreakdown = computeCorrectionBreakdown(threads);

  res.json({
    ok: true,
    total,
    counts,
    decidedBy,
    statusCounts,
    currentRates: {
      autoRatePercent: percent(counts.auto, total) ?? 0,
      escalateRatePercent: percent(counts.escalate, total) ?? 0,
      skipRatePercent: percent(counts.skip, total) ?? 0,
    },
    targets: EVALUATION_TARGETS,
    correctionRate: {
      ...correctionRate,
      ...correctionBreakdown,
      targetMet:
        correctionRate.ratePercent == null ? null : correctionRate.ratePercent <= EVALUATION_TARGETS.correctionMaxPercent,
    },
    ratings: {
      ...ratings,
      totalRatings,
      usablePercent,
      targetMet: usablePercent == null ? null : usablePercent >= EVALUATION_TARGETS.usabilityMinPercent,
    },
    draftSources,
    handlingTime: summarizeHandlingTimes(threads),
  });
});

// Vite Dev Server / Static Hosting
if (IS_PRODUCTION) {
  app.use(express.static(path.resolve(__dirname, "dist")));
  // Unmatched /api/* must 404 as JSON rather than falling through to the SPA
  // shell and returning index.html with a 200.
  app.use("/api", (_req, res) => {
    res.status(404).json({ ok: false, error: "Not found" });
  });
  // Express 5 (path-to-regexp 8) rejects the bare "*" wildcard; "{*splat}" is the
  // equivalent catch-all and also matches the bare "/" path.
  app.get("/{*splat}", (req, res) => {
    res.sendFile(path.resolve(__dirname, "dist/index.html"));
  });
} else {
  // Imported lazily so a production install without devDependencies can boot.
  const { createServer: createViteServer } = await import("vite");
  const vite = await createViteServer({
    server: {
      middlewareMode: true,
      host: HOST,
      allowedHosts: true,
    },
    appType: "spa",
  });
  app.use(vite.middlewares);
}

// Final error handler: JSON for API clients, generic messages for 5xx so
// internal errors (stack traces, provider messages) never reach the client.
app.use((err, _req, res, _next) => {
  const status = Number.isInteger(err?.status) ? err.status : 500;
  if (status >= 500) console.error("Unhandled request error:", err);
  const message = status >= 500
    ? "Internal server error"
    : err?.message || "Bad request";
  res.status(status).json({ ok: false, error: message });
});

const server = app.listen(PORT, HOST, () => {
  const address = server.address();
  const boundPort = typeof address === "object" && address ? address.port : PORT;
  console.log(
    `Outreach Pipeline MVP listening on http://${HOST}:${boundPort} (mode=${IS_PRODUCTION ? "production" : "development"})`
  );
});

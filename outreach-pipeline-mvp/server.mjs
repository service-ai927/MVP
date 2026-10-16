import express from "express";
import cors from "cors";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer } from "vite";
import { triageThread, generateCustomDraft } from "./src/ai-service.mjs";
import {
  ensureOriginalClassification,
  applyHumanClassification,
  markHumanReviewed,
  prepareImportedThread,
  computeCorrectionRate,
} from "./src/correction-rate.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "5mb" }));

const sampleDataPath = path.resolve(__dirname, "src/sample-threads.json");
const dataDirectory = path.resolve(__dirname, ".data");
const persistedDataPath = path.join(dataDirectory, "threads.json");

function normalizeThreads(items) {
  if (!Array.isArray(items)) return [];
  return structuredClone(items)
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
    const { contactName, handle, platform, account, messageText, memo } = req.body;

    if (!messageText || !messageText.trim()) {
      return res.status(400).json({ ok: false, error: "Message text is required" });
    }

    const threadId = `th-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const newThread = {
      counterpart: {
        id: contactName?.trim() || "New Contact",
        handle: handle?.trim() || "@unknown",
        profile_url: "",
        memo: memo?.trim() || "",
      },
      medium: {
        type: platform || "x",
        account: account || "Default Account",
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
    res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

// Update contact context/memo
app.put("/api/threads/:id/memo", (req, res) => {
  const thread = threads.find((item) => item.thread.id === req.params.id);
  if (!thread) {
    return res.status(404).json({ ok: false, error: "Thread not found" });
  }

  const { memo, handle, name } = req.body;
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
    const result = await triageThread(thread, { tone });

    thread.classification = result.classification;
    // First AI assignment only: preserves the original AI classification so a
    // later human override cannot erase it.
    ensureOriginalClassification(thread);
    thread.draft = {
      ...thread.draft,
      generated: result.draft.generated,
      gate: result.draft.gate,
      send_status: result.draft.send_status,
    };

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
    res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

// Generate or regenerate draft with custom guidance
app.post("/api/threads/:id/generate-draft", async (req, res) => {
  const thread = threads.find((item) => item.thread.id === req.params.id);
  if (!thread) {
    return res.status(404).json({ ok: false, error: "Thread not found" });
  }

  try {
    const { promptGuidance, tone } = req.body;
    const result = await generateCustomDraft(thread, promptGuidance, tone);

    if (!thread.draft) thread.draft = {};
    thread.draft.generated = result.draft;
    thread.draft.generator = result.source || "unknown";
    thread.draft.gate = result.gate;
    thread.draft.send_status = "held_for_human";
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
    res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

// Batch triage on all pending/new threads
app.post("/api/triage-all", async (req, res) => {
  try {
    let triagedCount = 0;
    for (const thread of threads) {
      if (
        thread.classification.action === "pending" ||
        thread.thread.status === "open" ||
        thread.thread.status === "New"
      ) {
        const result = await triageThread(thread);
        thread.classification = result.classification;
        ensureOriginalClassification(thread);
        thread.draft = result.draft;
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
    res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

// Workflow Actions
app.post("/api/threads/:id/action", (req, res) => {
  const thread = threads.find((item) => item.thread.id === req.params.id);
  if (!thread) {
    return res.status(404).json({ ok: false, error: "Thread not found" });
  }

  const { action, draft, classification, rating, feedback, seconds } = req.body;

  const approvedDraft = action === "approve"
    ? String(draft ?? thread.draft?.edited ?? thread.draft?.generated ?? "").trim()
    : "";

  if (action === "approve" && !approvedDraft) {
    return res.status(400).json({ ok: false, error: "A non-empty reply draft is required before approval" });
  }

  switch (action) {
    case "update_classification": {
      const payload = classification || {};
      const allowedActions = ["auto", "escalate", "skip"];
      if (!allowedActions.includes(payload.action)) {
        return res.status(400).json({ ok: false, error: "Invalid classification action" });
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
      markHumanReviewed(thread);
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
      markHumanReviewed(thread);
      break;

    case "rate_draft":
      thread.quality_rating = rating || null;
      thread.quality_feedback = feedback || "";
      break;

    case "record_time":
      if (typeof seconds === "number" && seconds > 0) {
        thread.handling_time_seconds = (thread.handling_time_seconds || 0) + seconds;
      }
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
    const incoming = req.body?.threads;
    if (!Array.isArray(incoming)) {
      return res.status(400).json({ ok: false, error: "threads must be an array" });
    }

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
    res.status(500).json({ ok: false, error: error?.message || String(error) });
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
    "Handling Time (s)",
    "Last Message",
    "Draft Generated",
    "Draft Edited",
    "Gate",
    "Send Status",
    "Quality Rating",
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
      escapeCsv(t.handling_time_seconds || 0),
      escapeCsv(lastMsg),
      escapeCsv(t.draft?.generated || ""),
      escapeCsv(t.draft?.edited || ""),
      escapeCsv(t.draft?.gate || ""),
      escapeCsv(t.draft?.send_status || ""),
      escapeCsv(t.quality_rating || ""),
    ].join(",");
  });

  const csvContent = "\uFEFF" + [headers.join(","), ...rows].join("\n");
  res.setHeader("Content-Disposition", "attachment; filename=outreach-threads.csv");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.send(csvContent);
});

// Reset to Sample Threads
app.post("/api/reset-samples", (_req, res) => {
  threads = loadSampleThreads();
  if (!persistThreads()) return res.status(500).json({ ok: false, error: "Could not save reset data" });
  res.json({
    ok: true,
    message: "Reset to 12 benchmark sample threads",
    total: threads.length,
    threads,
  });
});

// Metrics & 5-Day Validation Analytics
app.get("/api/metrics", (_req, res) => {
  const total = threads.length;
  let autoCount = 0;
  let escalateCount = 0;
  let skipCount = 0;
  let unclassifiedCount = 0;

  let completedCount = 0;
  let onHoldCount = 0;
  let needsReviewCount = 0;
  let draftGeneratedCount = 0;
  let returnedCount = 0;

  let totalHandlingSeconds = 0;
  let threadsWithTime = 0;

  let helpfulRatings = 0;
  let minorEditRatings = 0;
  let poorRatings = 0;

  for (const t of threads) {
    const act = t.classification?.action;
    if (act === "auto") autoCount++;
    else if (act === "escalate") escalateCount++;
    else if (act === "skip") skipCount++;
    else unclassifiedCount++;

    const status = t.thread?.status;
    const sendStatus = t.draft?.send_status;

    if (status === "handled" || sendStatus === "sent") completedCount++;
    else if (status === "on_hold") onHoldCount++;
    else if (status === "returned_for_revision") returnedCount++;
    else if (status === "needs_review" || act === "escalate") needsReviewCount++;
    else if (status === "draft_generated" || t.draft?.generated) draftGeneratedCount++;

    if (t.handling_time_seconds && t.handling_time_seconds > 0) {
      totalHandlingSeconds += t.handling_time_seconds;
      threadsWithTime++;
    }

    if (t.quality_rating === "helpful") helpfulRatings++;
    else if (t.quality_rating === "minor_edit") minorEditRatings++;
    else if (t.quality_rating === "poor") poorRatings++;
  }

  const baseline21Days = {
    sampleSize: 251,
    periodDays: 21,
    autoRatePercent: 30, // 30% could be handled by preparing reply draft
    escalateRatePercent: 49, // 49% required operator's own judgment
    skipRatePercent: 21, // 21% did not require a reply
    estimatedManualTimePerMsgSec: 300, // 5 minutes estimated manual handling
  };

  const avgHandlingTimeSec = threadsWithTime > 0
    ? Math.round(totalHandlingSeconds / threadsWithTime)
    : null;

  const currentRates = {
    autoRatePercent: total > 0 ? Math.round((autoCount / total) * 100) : 0,
    escalateRatePercent: total > 0 ? Math.round((escalateCount / total) * 100) : 0,
    skipRatePercent: total > 0 ? Math.round((skipCount / total) * 100) : 0,
  };

  // Estimated time saved calculation:
  // Manual time (300s) vs AI-assisted time
  const estimatedTimeSavedMinutes = threadsWithTime > 0
    ? Math.max(Math.round(
        ((baseline21Days.estimatedManualTimePerMsgSec - avgHandlingTimeSec) * threadsWithTime) / 60
      ), 0)
    : null;

  // Human correction rate over eligible items only:
  // original AI classification available AND human review completed.
  const correctionRate = computeCorrectionRate(threads);

  res.json({
    ok: true,
    total,
    counts: {
      auto: autoCount,
      escalate: escalateCount,
      skip: skipCount,
      unclassified: unclassifiedCount,
    },
    statusCounts: {
      completed: completedCount,
      draftGenerated: draftGeneratedCount,
      needsReview: needsReviewCount,
      onHold: onHoldCount,
      returned: returnedCount,
    },
    currentRates,
    baseline21Days,
    correctionRate,
    handlingTime: {
      totalSeconds: totalHandlingSeconds,
      averageSecondsPerMsg: avgHandlingTimeSec,
      estimatedTimeSavedMinutes,
    },
    ratings: {
      helpful: helpfulRatings,
      minorEdit: minorEditRatings,
      poor: poorRatings,
      totalRatings: helpfulRatings + minorEditRatings + poorRatings,
    },
  });
});

// Vite Dev Server / Static Hosting
if (process.env.NODE_ENV === "production") {
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
  const vite = await createViteServer({
    server: {
      middlewareMode: true,
      host: "0.0.0.0",
      allowedHosts: true,
    },
    appType: "spa",
  });
  app.use(vite.middlewares);
}

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Outreach Pipeline MVP running on http://0.0.0.0:${PORT}`);
});

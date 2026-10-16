import test from "node:test";
import assert from "node:assert/strict";
import {
  ensureOriginalClassification,
  applyHumanClassification,
  markHumanReviewed,
  prepareImportedThread,
  computeCorrectionRate,
  hasOriginalClassification,
  isHumanReviewed,
  isCorrectedClassification,
} from "../src/correction-rate.mjs";

function aiThread(overrides = {}) {
  return {
    counterpart: { id: "相手A", handle: "@userA", profile_url: "", memo: "" },
    medium: { type: "x", account: "Lily" },
    thread: { id: "x-A", last_incoming_at: "2026-09-07T17:39:00+09:00", status: "open" },
    messages: [{ from: "counterpart", text: "ありがとうございます", at: "2026-09-07T17:39:00+09:00" }],
    classification: {
      action: "auto",
      category: "お礼への返信",
      reason: "お礼の返信のため自動対応可能",
      decided_by: "llm",
      rule_hit: null,
    },
    draft: {
      generated: "ご連絡ありがとうございます。",
      edited: null,
      gate: "合格",
      send_status: "held_for_human",
    },
    handling_time_seconds: 0,
    quality_rating: null,
    ...overrides,
  };
}

function rateOf(...threads) {
  return computeCorrectionRate(threads);
}

test("reviewed item whose classification is unchanged is eligible but not corrected", () => {
  const thread = aiThread();
  ensureOriginalClassification(thread);

  // Operator opens the classification panel and saves without changing anything.
  applyHumanClassification(thread, {
    action: "auto",
    category: "お礼への返信",
    reason: "お礼の返信のため自動対応可能",
  });

  assert.equal(hasOriginalClassification(thread), true);
  assert.equal(isHumanReviewed(thread), true);
  assert.equal(isCorrectedClassification(thread), false);

  const rate = rateOf(thread);
  assert.equal(rate.eligibleReviewedItems, 1);
  assert.equal(rate.correctedItems, 0);
  assert.equal(rate.ratePercent, 0);
});

test("final classification that differs from the original AI classification counts as a correction", () => {
  const thread = aiThread();
  ensureOriginalClassification(thread);

  applyHumanClassification(thread, {
    action: "escalate",
    category: "日程・MTGの日時",
    reason: "日程の打診のため担当者確認が必要",
  });

  // The original AI classification is preserved, not overwritten.
  assert.equal(thread.original_classification.action, "auto");
  assert.equal(thread.original_classification.category, "お礼への返信");
  assert.equal(thread.original_classification.decided_by, "llm");
  assert.equal(thread.classification.action, "escalate");
  assert.equal(thread.classification.decided_by, "human");

  const rate = rateOf(thread);
  assert.deepEqual(rate, { eligibleReviewedItems: 1, correctedItems: 1, ratePercent: 100 });
});

test("repeated human edits contribute at most one correction", () => {
  const thread = aiThread();
  ensureOriginalClassification(thread);

  applyHumanClassification(thread, { action: "escalate", category: "日程・MTGの日時", reason: "1回目" });
  applyHumanClassification(thread, { action: "skip", category: "スパム", reason: "2回目" });
  applyHumanClassification(thread, {
    action: "auto",
    category: "カジュアルな質問",
    reason: "3回目",
  });

  const rate = rateOf(thread);
  assert.deepEqual(rate, { eligibleReviewedItems: 1, correctedItems: 1, ratePercent: 100 });

  // Editing back to the original AI classification removes the correction.
  applyHumanClassification(thread, {
    action: "auto",
    category: "お礼への返信",
    reason: "元に戻す",
  });
  const reverted = rateOf(thread);
  assert.deepEqual(reverted, { eligibleReviewedItems: 1, correctedItems: 0, ratePercent: 0 });
});

test("re-running AI triage never overwrites the preserved original classification", () => {
  const thread = aiThread();
  ensureOriginalClassification(thread);
  applyHumanClassification(thread, {
    action: "escalate",
    category: "金額・条件・契約",
    reason: "単価の相談のため担当者確認",
  });

  // Simulate a later AI re-triage producing a different classification.
  thread.classification = {
    action: "skip",
    category: "業者の一斉営業",
    reason: "営業と判断",
    decided_by: "rule",
    rule_hit: "blast",
  };
  ensureOriginalClassification(thread);

  assert.equal(thread.original_classification.action, "auto");
  assert.equal(thread.original_classification.category, "お礼への返信");
  assert.deepEqual(rateOf(thread), { eligibleReviewedItems: 1, correctedItems: 1, ratePercent: 100 });
});

test("item with no original AI classification is excluded instead of counted as uncorrected", () => {
  // Historical record: the classification was made (or last changed) by a human and
  // no original AI snapshot exists. It must not be invented.
  const thread = aiThread({
    classification: {
      action: "escalate",
      category: "日程・MTGの日時",
      reason: "過去の手動分類",
      decided_by: "human",
      rule_hit: null,
    },
  });

  ensureOriginalClassification(thread);
  markHumanReviewed(thread);

  assert.equal(hasOriginalClassification(thread), false);
  assert.equal(isHumanReviewed(thread), true);
  assert.equal(isCorrectedClassification(thread), false);

  const rate = rateOf(thread);
  assert.deepEqual(rate, { eligibleReviewedItems: 0, correctedItems: 0, ratePercent: null });
});

test("item that has not completed human review is excluded", () => {
  const thread = aiThread();
  ensureOriginalClassification(thread);

  assert.equal(hasOriginalClassification(thread), true);
  assert.equal(isHumanReviewed(thread), false);

  const rate = rateOf(thread);
  assert.deepEqual(rate, { eligibleReviewedItems: 0, correctedItems: 0, ratePercent: null });
});

test("summary with zero eligible items never reports NaN or Infinity", () => {
  const empty = computeCorrectionRate([]);
  assert.deepEqual(empty, { eligibleReviewedItems: 0, correctedItems: 0, ratePercent: null });

  const noEligible = rateOf(aiThread(), {
    classification: { action: "escalate", category: "その他・不明", reason: "", decided_by: "human" },
  });
  assert.equal(noEligible.eligibleReviewedItems, 0);
  assert.equal(noEligible.correctedItems, 0);
  assert.equal(noEligible.ratePercent, null);
  assert.equal(Number.isNaN(noEligible.ratePercent), false);
  assert.equal(Number.isFinite(noEligible.ratePercent), false);

  assert.deepEqual(computeCorrectionRate(undefined), {
    eligibleReviewedItems: 0,
    correctedItems: 0,
    ratePercent: null,
  });
});

test("mixed set counts only eligible human-reviewed items", () => {
  const corrected = aiThread();
  ensureOriginalClassification(corrected);
  applyHumanClassification(corrected, { action: "skip", category: "スパム", reason: "spam" });

  const unchanged = aiThread({ thread: { id: "x-B", status: "open" } });
  ensureOriginalClassification(unchanged);
  markHumanReviewed(unchanged);

  const unreviewed = aiThread({ thread: { id: "x-C", status: "open" } });
  ensureOriginalClassification(unreviewed);

  const noOriginal = aiThread({
    thread: { id: "x-D", status: "open" },
    classification: { action: "auto", category: "その他・不明", reason: "", decided_by: "human" },
  });
  markHumanReviewed(noOriginal);

  assert.deepEqual(rateOf(corrected, unchanged, unreviewed, noOriginal), {
    eligibleReviewedItems: 2,
    correctedItems: 1,
    ratePercent: 50,
  });
});

test("saving, reloading, and re-importing keeps the original classification and review state", () => {
  const thread = aiThread();
  ensureOriginalClassification(thread);
  applyHumanClassification(thread, {
    action: "escalate",
    category: "金額・条件・契約",
    reason: "報酬の相談のため担当者確認",
  });

  // Save + reload through the JSON persistence format.
  const reloaded = JSON.parse(JSON.stringify({ threads: [thread] })).threads[0];
  ensureOriginalClassification(reloaded); // runs again on every load, as normalizeThreads does

  assert.equal(reloaded.original_classification.action, "auto");
  assert.equal(reloaded.classification.action, "escalate");
  assert.equal(isHumanReviewed(reloaded), true);
  assert.deepEqual(rateOf(reloaded), { eligibleReviewedItems: 1, correctedItems: 1, ratePercent: 100 });

  // Import of a fresh AI-classified record derives the original (sample format).
  const importedFresh = prepareImportedThread(aiThread());
  assert.equal(importedFresh.original_classification.action, "auto");
  assert.equal(isHumanReviewed(importedFresh), false);

  // Re-import over an existing record must not drop the stored original or review flag.
  const incomingWithoutSnapshot = aiThread({
    classification: {
      action: "escalate",
      category: "金額・条件・契約",
      reason: "再振り分け後のAI分類",
      decided_by: "llm",
      rule_hit: null,
    },
  });
  const merged = prepareImportedThread(incomingWithoutSnapshot, reloaded);
  assert.equal(merged.original_classification.action, "auto");
  assert.equal(isHumanReviewed(merged), true);
  assert.equal(isCorrectedClassification(merged), true);

  // Importing a human-decided record without an original never invents one.
  const legacyImport = prepareImportedThread(
    aiThread({
      classification: { action: "escalate", category: "日程・MTGの日時", reason: "", decided_by: "human" },
    })
  );
  assert.equal(hasOriginalClassification(legacyImport), false);
  assert.deepEqual(rateOf(legacyImport), {
    eligibleReviewedItems: 0,
    correctedItems: 0,
    ratePercent: null,
  });
});

test("marking human review is idempotent", () => {
  const thread = aiThread();
  ensureOriginalClassification(thread);
  markHumanReviewed(thread);
  const firstStamp = thread.human_reviewed_at;
  markHumanReviewed(thread);
  assert.equal(thread.human_reviewed_at, firstStamp);
});

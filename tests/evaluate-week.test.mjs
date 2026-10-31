import test from "node:test";
import assert from "node:assert/strict";
import { buildEvaluationReport, parseExportPayload, parseHandlingLog } from "../scripts/evaluate-week.mjs";

function item(id, overrides = {}) {
  return {
    thread: { id },
    original_classification: { action: "auto", category: "question" },
    classification: { action: "auto", category: "question", decided_by: "human" },
    human_reviewed_at: "2026-10-28T10:00:00.000Z",
    human_reviewed_via: "update_classification",
    quality_rating: null,
    quality_rated_at: "2026-10-28T10:00:00.000Z",
    handling_time_seconds: 0,
    ...overrides,
  };
}

test("computes date-scoped headline and strict correction rates and draft usability", () => {
  const rows = [
    item("a", { classification: { action: "skip", category: "spam", decided_by: "human" }, quality_rating: "helpful", handling_time_seconds: 20 }),
    item("b", { quality_rating: "minor_edit", handling_time_seconds: 40 }),
    item("c", { quality_rating: "poor", handling_time_seconds: 60 }),
    item("d", { human_reviewed_via: "approve", quality_rating: "helpful" }),
    item("outside", { human_reviewed_at: "2026-10-20T10:00:00.000Z", quality_rated_at: "2026-10-20T10:00:00.000Z", quality_rating: "poor" }),
  ];
  const report = buildEvaluationReport({ threads: rows }, "2026-10-28T00:00:00Z", "2026-10-29T00:00:00Z");
  assert.equal(report.classification.headline.eligible, 4);
  assert.equal(report.classification.headline.corrected, 1);
  assert.equal(report.classification.headline.ratePercent, 25);
  assert.equal(report.classification.strictExplicitClassificationReview.eligible, 3);
  assert.equal(report.classification.strictExplicitClassificationReview.corrected, 1);
  assert.equal(report.draftUsability.ratedCount, 4);
  assert.equal(report.draftUsability.usablePercent, 75);
  assert.deepEqual(report.handlingTime.seconds, []);
  assert.match(report.handlingTime.warning, /operator's contemporaneous log/);
  assert.equal(report.dataQuality.totalThreadsInExport, 5);
});

test("does not leak message text or thread IDs in report and handles empty denominators", () => {
  const report = buildEvaluationReport([item("private-id", {
    messages: [{ text: "private client message" }],
    original_classification: undefined,
    quality_rating: null,
  })], "2026-10-28T00:00:00Z", "2026-10-29T00:00:00Z");
  assert.equal(report.classification.headline.ratePercent, null);
  assert.equal(report.classification.strictExplicitClassificationReview.ratePercent, null);
  assert.equal(report.draftUsability.usablePercent, null);
  assert.equal(JSON.stringify(report).includes("private-id"), false);
  assert.equal(JSON.stringify(report).includes("private client message"), false);
});

test("rejects invalid date ranges and malformed exports", () => {
  assert.throws(() => buildEvaluationReport([], "bad", "2026-10-29T00:00:00Z"), /valid ISO|explicit timezone/);
  assert.throws(() => buildEvaluationReport([], "2026-10-29T00:00:00Z", "2026-10-28T00:00:00Z"), /later/);
  assert.throws(() => buildEvaluationReport({}, "2026-10-28T00:00:00Z", "2026-10-29T00:00:00Z"), /threads array/);
});

test("requires an explicit timezone offset on --start and --end", () => {
  // Timezone-less values would be silently interpreted and could shift the
  // whole window; they must be rejected instead of guessed.
  assert.throws(
    () => buildEvaluationReport([], "2026-10-28T00:00:00", "2026-10-29T00:00:00Z"),
    /explicit timezone/
  );
  assert.throws(
    () => buildEvaluationReport([], "2026-10-28", "2026-10-29T00:00:00Z"),
    /explicit timezone/
  );

  // Both "Z" and numeric offsets are accepted, and the window is compared in UTC.
  const jstMorning = buildEvaluationReport(
    [item("in-window"), item("excluded", { human_reviewed_at: "2026-10-27T14:59:59.000Z", quality_rated_at: "2026-10-27T14:59:59.000Z" })],
    "2026-10-28T00:00:00+09:00",
    "2026-10-29T00:00:00+09:00"
  );
  assert.equal(jstMorning.period.start, "2026-10-27T15:00:00.000Z");
  assert.equal(jstMorning.classification.headline.eligible, 1);
});

test("ignores duplicate thread IDs instead of double counting them", () => {
  const rows = [
    item("dup", { quality_rating: "helpful" }),
    item("dup", { quality_rating: "poor" }),
    item("other", { quality_rating: "helpful" }),
  ];
  const report = buildEvaluationReport({ threads: rows }, "2026-10-28T00:00:00Z", "2026-10-29T00:00:00Z");
  assert.equal(report.dataQuality.totalThreadsInExport, 3);
  assert.equal(report.dataQuality.duplicateThreadIds, 1);
  assert.match(report.dataQuality.duplicateThreadIdsWarning, /duplicate thread\.id/);
  assert.equal(report.classification.headline.eligible, 2, "first occurrence only");
  assert.equal(report.draftUsability.ratedCount, 2);
});

test("ratings without a timestamp are excluded and surfaced, not counted", () => {
  const legacy = item("legacy", { quality_rating: "helpful", quality_rated_at: undefined });
  const report = buildEvaluationReport({ threads: [legacy] }, "2026-10-28T00:00:00Z", "2026-10-29T00:00:00Z");
  assert.equal(report.draftUsability.ratedCount, 0, "an untimestamped rating cannot be placed in the window");
  assert.equal(report.draftUsability.usablePercent, null);
  assert.equal(report.dataQuality.ratingsMissingTimestamp, 1);
  assert.match(report.dataQuality.ratingsMissingTimestampWarning, /excluded from every window/);
});

test("handles an empty dataset without fabricating results", () => {
  const report = buildEvaluationReport({ threads: [] }, "2026-10-28T00:00:00Z", "2026-10-29T00:00:00Z");
  assert.equal(report.classification.headline.eligible, 0);
  assert.equal(report.classification.headline.ratePercent, null);
  assert.equal(report.classification.headline.targetMet, null);
  assert.equal(report.draftUsability.usablePercent, null);
  assert.equal(report.draftUsability.targetMet, null);
  assert.match(report.handlingTime.warning, /contemporaneous log/);
});

test("survives malformed entries in the threads array", () => {
  const rows = [null, "not-a-thread", 42, item("real", { quality_rating: "helpful" })];
  const report = buildEvaluationReport({ threads: rows }, "2026-10-28T00:00:00Z", "2026-10-29T00:00:00Z");
  assert.equal(report.dataQuality.totalThreadsInExport, 4);
  assert.equal(report.classification.headline.eligible, 1);
  assert.equal(report.draftUsability.ratedCount, 1);
});

test("thresholds are configurable and validated", () => {
  const rows = [
    item("a", { classification: { action: "skip", category: "spam", decided_by: "human" } }),
    item("b"),
    item("c"),
    item("d"),
  ];
  const strict = buildEvaluationReport({ threads: rows }, "2026-10-28T00:00:00Z", "2026-10-29T00:00:00Z", { targetCorrectionMax: 20 });
  assert.equal(strict.classification.headline.ratePercent, 25);
  assert.equal(strict.classification.headline.targetPercentMax, 20);
  assert.equal(strict.classification.headline.targetMet, false, "25% exceeds a 20% ceiling");

  const relaxed = buildEvaluationReport({ threads: rows }, "2026-10-28T00:00:00Z", "2026-10-29T00:00:00Z", { targetCorrectionMax: 30 });
  assert.equal(relaxed.classification.headline.targetMet, true);

  assert.throws(
    () => buildEvaluationReport([], "2026-10-28T00:00:00Z", "2026-10-29T00:00:00Z", { targetUsabilityMin: 150 }),
    /between 0 and 100/
  );
});

test("accepts export files with a leading UTF-8 BOM (PowerShell default encoding)", () => {
  // Windows PowerShell writes a BOM by default; JSON.parse rejects it.
  const payload = parseExportPayload('\uFEFF{"threads":[]}');
  assert.deepEqual(payload, { threads: [] });
  // No BOM (what /api/export produces) parses unchanged.
  assert.deepEqual(parseExportPayload('{"threads":[{"thread":{"id":"a"}}]}').threads.length, 1);
  // Malformed JSON still surfaces its real error, not a BOM-shaped one.
  assert.throws(() => parseExportPayload("{not json"), SyntaxError);
});

test("operator handling log populates first-10 timings; short logs are flagged insufficient", () => {
  const base = () => buildEvaluationReport([], "2026-10-28T00:00:00Z", "2026-10-29T00:00:00Z");
  // No log: unchanged refusal to infer, original warning preserved.
  const none = base();
  assert.equal(none.handlingTime.source, "not-available");
  assert.deepEqual(none.handlingTime.seconds, []);
  assert.match(none.handlingTime.warning, /operator's contemporaneous log/);

  // Complete sample of 10: reported with mean/median, no warning.
  const full = buildEvaluationReport([], "2026-10-28T00:00:00Z", "2026-10-29T00:00:00Z", {
    handlingLog: parseHandlingLog(Array.from({ length: 10 }, (_, i) => ({ entry: i + 1, seconds: 30 + i * 10 }))),
  });
  assert.equal(full.handlingTime.source, "operator-log");
  assert.equal(full.handlingTime.sampleComplete, true);
  assert.equal(full.handlingTime.seconds.length, 10);
  assert.equal(full.handlingTime.meanSeconds, 75);
  assert.equal(full.handlingTime.medianSeconds, 75);
  assert.equal(full.handlingTime.warning, null);

  // Short sample: explicit insufficient-data warning, never a fabricated result.
  const short = buildEvaluationReport([], "2026-10-28T00:00:00Z", "2026-10-29T00:00:00Z", {
    handlingLog: parseHandlingLog([{ entry: 1, seconds: 42 }]),
  });
  assert.equal(short.handlingTime.sampleComplete, false);
  assert.match(short.handlingTime.warning, /Insufficient data/);
});

test("handling log validation rejects bad values and accepts the entries wrapper", () => {
  assert.deepEqual(parseHandlingLog({ entries: [{ entry: 2, seconds: 15 }] }), [{ entry: 2, seconds: 15 }]);
  // An omitted entry number is never inferred from position.
  assert.throws(() => parseHandlingLog([{ seconds: 9 }]), /"entry" is required/);
  assert.throws(() => parseHandlingLog([{ entry: null, seconds: 9 }]), /"entry" is required/);
  assert.throws(() => parseHandlingLog([{ seconds: -5 }]), /"entry" is required/);
  assert.throws(() => parseHandlingLog([{ entry: 1, seconds: -5 }]), /seconds/);
  assert.throws(() => parseHandlingLog([{ entry: 1, seconds: 99999 }]), /seconds/);
  assert.throws(() => parseHandlingLog([{ entry: 1, seconds: "42" }]), /seconds/);
  assert.throws(() => parseHandlingLog({ nope: 1 }), /array/);
});

test("handling log: entry numbers must be integers from 1 through 10", () => {
  // In range and explicit — the valid format, unchanged.
  assert.deepEqual(parseHandlingLog([{ entry: 1, seconds: 9 }, { entry: 10, seconds: 11 }]), [
    { entry: 1, seconds: 9 },
    { entry: 10, seconds: 11 },
  ]);
  // Out of range: zero, negative, and above 10.
  assert.throws(() => parseHandlingLog([{ entry: 0, seconds: 9 }]), /integer from 1 to 10/);
  assert.throws(() => parseHandlingLog([{ entry: -3, seconds: 9 }]), /integer from 1 to 10/);
  assert.throws(() => parseHandlingLog([{ entry: 11, seconds: 9 }]), /integer from 1 to 10/);
  // Decimals are not sequence numbers.
  assert.throws(() => parseHandlingLog([{ entry: 1.5, seconds: 9 }]), /integer from 1 to 10/);
  assert.throws(() => parseHandlingLog([{ entry: 2.7, seconds: 9 }]), /integer from 1 to 10/);
  // Strings and booleans are not silently coerced.
  assert.throws(() => parseHandlingLog([{ entry: "3", seconds: 9 }]), /integer from 1 to 10/);
  assert.throws(() => parseHandlingLog([{ entry: true, seconds: 9 }]), /integer from 1 to 10/);
});

test("handling log: duplicate entry numbers are rejected", () => {
  assert.throws(
    () => parseHandlingLog([
      { entry: 1, seconds: 10 },
      { entry: 1, seconds: 12 },
    ]),
    /duplicate entry number 1/
  );
  // A duplicate that would otherwise be a 10-row set (two 8s, missing 10).
  const tenWithDupe = Array.from({ length: 9 }, (_, i) => ({ entry: i === 6 ? 8 : i + 1, seconds: 30 }))
    .concat([{ entry: 7, seconds: 30 }]);
  assert.throws(() => parseHandlingLog(tenWithDupe), /duplicate entry number/);
});

test("handling log: more than 10 entries are rejected, never truncated", () => {
  const eleven = Array.from({ length: 11 }, (_, i) => ({ entry: i + 1 > 10 ? 1 : i + 1, seconds: 30 }));
  // 11 rows even with a duplicated number must fail on the count first.
  assert.throws(() => parseHandlingLog(eleven), /at most 10/);
  // Eleven distinct in-range numbers are impossible, so also try a plain 11-row file with repeats.
  const elevenRepeated = Array.from({ length: 11 }, (_, i) => ({ entry: (i % 10) + 1, seconds: 30 }));
  assert.throws(() => parseHandlingLog(elevenRepeated), /at most 10/);
  // Exactly 10 remains valid.
  assert.equal(parseHandlingLog(Array.from({ length: 10 }, (_, i) => ({ entry: i + 1, seconds: 30 }))).length, 10);
});

test("final report marks the first-10 sample complete only for entries 1-10 exactly once", () => {
  const window = ["2026-10-28T00:00:00Z", "2026-10-29T00:00:00Z"];
  const report = (handlingLog) => buildEvaluationReport([], window[0], window[1], { handlingLog });

  // 1..10 each exactly once -> complete.
  const full = report(parseHandlingLog(Array.from({ length: 10 }, (_, i) => ({ entry: i + 1, seconds: 30 }))));
  assert.equal(full.handlingTime.sampleComplete, true);
  assert.equal(full.handlingTime.warning, null);

  // Missing one number (9 rows) -> incomplete with the insufficient-data warning.
  const nine = report(parseHandlingLog(
    Array.from({ length: 9 }, (_, i) => ({ entry: i + 1, seconds: 30 }))
  ));
  assert.equal(nine.handlingTime.sampleComplete, false);
  assert.match(nine.handlingTime.warning, /only 9 of 10/);

  // Defense in depth: even a hand-built array with a duplicate or a missing
  // number is never marked complete, and >10 rows abort instead of slicing.
  const withDupe = Array.from({ length: 9 }, (_, i) => ({ entry: i === 8 ? 1 : i + 1, seconds: 30 }));
  assert.throws(() => report(withDupe), /duplicate entry number/);
  const eleven = Array.from({ length: 11 }, (_, i) => ({ entry: (i % 10) + 1, seconds: 30 }));
  assert.throws(() => report(eleven), /at most 10/);
});

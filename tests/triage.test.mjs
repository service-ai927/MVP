import test from "node:test";
import assert from "node:assert/strict";
import { shouldAutoTriage } from "../src/triage.mjs";

function thread(overrides = {}) {
  return {
    classification: { action: "pending", category: "", reason: "", decided_by: null },
    thread: { id: "x-A", status: "open" },
    ...overrides,
  };
}

test("pending classifications are eligible for bulk triage", () => {
  assert.equal(shouldAutoTriage(thread()), true);
});

test("open and New threads without a human decision are eligible", () => {
  assert.equal(shouldAutoTriage(thread({ thread: { status: "open" } })), true);
  assert.equal(shouldAutoTriage(thread({ thread: { status: "New" } })), true);
});

test("human classification decisions are never re-triaged by bulk triage", () => {
  // The proven overwrite case: an imported thread a human classified as auto
  // without a draft keeps status "open" and must not be silently re-triaged.
  const humanAuto = thread({
    classification: { action: "auto", category: "マーケ相談", reason: "人的判断", decided_by: "human" },
    thread: { status: "open" },
  });
  assert.equal(shouldAutoTriage(humanAuto), false);

  const humanEscalate = thread({
    classification: { action: "escalate", category: "日程・MTGの日時", reason: "人的判断", decided_by: "human" },
    thread: { status: "needs_review" },
  });
  assert.equal(shouldAutoTriage(humanEscalate), false);
});

test("handled, held, and draft threads without a human decision stay eligible only when open", () => {
  assert.equal(
    shouldAutoTriage(thread({ classification: { action: "auto", decided_by: "llm" }, thread: { status: "draft_generated" } })),
    false
  );
  assert.equal(
    shouldAutoTriage(thread({ classification: { action: "escalate", decided_by: "rule" }, thread: { status: "needs_review" } })),
    false
  );
  assert.equal(
    shouldAutoTriage(thread({ classification: { action: "auto", decided_by: "llm" }, thread: { status: "open" } })),
    true
  );
});

test("threads without a classification object are treated as untriaged instead of crashing", () => {
  assert.equal(shouldAutoTriage({ thread: { status: "open" } }), true);
  assert.equal(shouldAutoTriage(null), false);
  assert.equal(shouldAutoTriage({}), false);
});

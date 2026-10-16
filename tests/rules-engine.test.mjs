import test from "node:test";
import assert from "node:assert/strict";
import { evaluateMachineRules, evaluateContentGate } from "../src/rules-engine.mjs";

test("routes scheduling messages to human review", () => {
  const result = evaluateMachineRules("来週の打ち合わせの日程を相談できますか？");
  assert.equal(result?.action, "escalate");
  assert.equal(result?.category, "日程・MTGの日時");
});

test("routes pricing and contract messages to human review", () => {
  const result = evaluateMachineRules("報酬の単価と契約条件を相談したいです");
  assert.equal(result?.action, "escalate");
  assert.equal(result?.category, "金額・条件・契約");
});

test("routes complaints to human review", () => {
  const result = evaluateMachineRules("返金について苦情があります");
  assert.equal(result?.action, "escalate");
  assert.equal(result?.category, "断り・クレーム・こじれ");
});

test("skips URL-only messages", () => {
  const result = evaluateMachineRules("https://example.com/landing");
  assert.equal(result?.action, "skip");
  assert.equal(result?.category, "リンクだけのDM");
});

test("skips promotional blasts", () => {
  const result = evaluateMachineRules("【期間限定】初月無料のSNS運用代行キャンペーン");
  assert.equal(result?.action, "skip");
});

test("escalates a draft that promises deliverables", () => {
  const result = evaluateContentGate("初稿を作成してお送りします。");
  assert.equal(result.passed, false);
});

test("escalates a draft that includes a specific date", () => {
  const result = evaluateContentGate("9/15にご連絡します。");
  assert.equal(result.passed, false);
});

test("escalates a draft that includes pricing", () => {
  const result = evaluateContentGate("費用は5万円です。");
  assert.equal(result.passed, false);
});

test("escalates a draft that includes an external URL", () => {
  const result = evaluateContentGate("こちらをご覧ください https://example.com");
  assert.equal(result.passed, false);
});

test("accepts a neutral draft with no commitments, prices, dates, or URLs", () => {
  const result = evaluateContentGate("ご連絡ありがとうございます。参考になりましたら幸いです。");
  assert.equal(result.passed, true);
});

test("rejects an empty draft", () => {
  const result = evaluateContentGate("  ");
  assert.equal(result.passed, false);
});

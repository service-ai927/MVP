import test from "node:test";
import assert from "node:assert/strict";
import { evaluateContentGate } from "../src/rules-engine.mjs";

test("content gate blocks nested deliverable promises", () => {
  for (const draft of [
    "LPの初稿をお送りします。",
    "初稿を作成します。",
    "サイトを開発します。",
    "仕様書を提出します。",
  ]) {
    assert.equal(evaluateContentGate(draft).passed, false, draft);
  }
});

test("content gate blocks concrete dates and clock times but allows durations", () => {
  for (const draft of [
    "11月5日にご連絡します。",
    "5/11に対応します。",
    "15時にお送りします。",
    "15:30にご連絡します。",
  ]) {
    assert.equal(evaluateContentGate(draft).passed, false, draft);
  }
  for (const draft of [
    "2時間ほど確認しました。",
    "24時間以内に対応できるか確認します。",
  ]) {
    assert.equal(evaluateContentGate(draft).passed, true, draft);
  }
});

test("content gate blocks monetary amounts while allowing metric milestones", () => {
  for (const draft of [
    "費用は5万円です。",
    "料金は3万円です。",
    "報酬は10万円です。",
    "見積もり額は5万円です。",
  ]) {
    assert.equal(evaluateContentGate(draft).passed, false, draft);
  }
  for (const draft of [
    "5万再生を達成されたのですね。",
    "フォロワー1万人はすごいですね。",
  ]) {
    assert.equal(evaluateContentGate(draft).passed, true, draft);
  }
});

test("content gate blocks unvetted URLs and accepts safe acknowledgements", () => {
  assert.equal(evaluateContentGate("詳細はこちら https://example.com").passed, false);
  assert.equal(evaluateContentGate("ご連絡ありがとうございます。内容を確認しました。").passed, true);
});


test("content gate allows a metric amount when the metric label precedes the number", () => {
  assert.equal(evaluateContentGate("フォロワー数は3万まで伸びました。あと少しで目標です。").passed, true);
});

test("content gate does not let a metric mention hide a separate monetary amount", () => {
  assert.equal(
    evaluateContentGate("5万再生おめでとうございます。料金は3万円です。").passed,
    false
  );
  assert.equal(evaluateContentGate("費用は3,000円です。").passed, false);
});

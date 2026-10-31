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

test("accepts a draft that mentions a duration but no clock time or date", () => {
  // Durations ("2時間") are not scheduling commitments.
  const result = evaluateContentGate("ご連絡ありがとうございます。お待たせして2時間すみません。");
  assert.equal(result.passed, true);
});

test("rejects a draft that mentions a clock time", () => {
  const result = evaluateContentGate("ご連絡ありがとうございます。15時にお願いします。");
  assert.equal(result.passed, false);
});

// --- Regression: false "Requires review" escalations found in real messages ---

test("does not escalate a duration mention combined with a day-of-month", () => {
  // "3日…2時間" used to match the weekday branch as if it were a clock time.
  const result = evaluateMachineRules("3日ほど前から2時間ずつ検証しています。");
  assert.equal(result, null);
});

test("escalates an actual day-of-month plus clock time", () => {
  const result = evaluateMachineRules("15日18時にお願いできませんか？");
  assert.equal(result?.action, "escalate");
  assert.equal(result?.category, "日程・MTGの日時");
});

test("does not escalate growth/how-to questions about metrics", () => {
  assert.equal(evaluateMachineRules("登録者数を増やしたいんですが、何をすればいいですか？"), null);
  assert.equal(evaluateMachineRules("ユーザー数を増やしたいです。どうすればいいですか？"), null);
});

test("still escalates questions asking for our performance numbers", () => {
  const result = evaluateMachineRules(
    "Lilyさんのアプリってどのくらいダウンロードされてるんですか？売上も差し支えなければ…"
  );
  assert.equal(result?.action, "escalate");
  assert.equal(result?.category, "実績の数字を聞かれている");
});

test("does not treat metric-context numbers as money", () => {
  // Followers/views are metrics, not payment amounts ("◯万円").
  assert.equal(evaluateMachineRules("フォロワー数は3万まで伸びました。あと少しで目標です。"), null);
});

test("still escalates money amounts, with or without the 円 suffix", () => {
  assert.equal(evaluateMachineRules("1件あたり◯万円お渡しします。")?.category, "金額・条件・契約");
  assert.equal(evaluateMachineRules("3万でお願いします。")?.category, "金額・条件・契約");
  assert.equal(evaluateMachineRules("月商は30万です。")?.category, "金額・条件・契約");
});

test("skips messages that explicitly state no reply is needed", () => {
  const result = evaluateMachineRules("返信不要です。またこちらからご連絡します。");
  assert.equal(result?.action, "skip");
  assert.equal(result?.category, "その他・不明");
});

test("does not skip messages where 不要 modifies something else", () => {
  const result = evaluateMachineRules("ご連絡不要な場合はご返信いただかなくても大丈夫です。");
  assert.equal(result, null);
});

test("rejects an empty draft", () => {
  const result = evaluateContentGate("  ");
  assert.equal(result.passed, false);
});


test("does not escalate historical meeting mentions or completed contract updates", () => {
  assert.equal(evaluateMachineRules("打ち合わせありがとうございました。とても参考になりました。"), null);
  assert.equal(evaluateMachineRules("先日、契約が完了しました。"), null);
  assert.equal(evaluateMachineRules("9/15に公開した機能の進捗を共有します。"), null);
});

test("still escalates explicit scheduling coordination", () => {
  assert.equal(evaluateMachineRules("来週の打ち合わせ、日程を調整できますか？")?.action, "escalate");
  assert.equal(evaluateMachineRules("15日18時にお願いできませんか？")?.action, "escalate");
});

test("still escalates active commercial decisions", () => {
  assert.equal(evaluateMachineRules("報酬の単価と契約条件を相談したいです")?.action, "escalate");
  assert.equal(evaluateMachineRules("契約条件を変更できるか確認したいです")?.action, "escalate");
});


test("escalates a dated availability question without explicit meeting keywords", () => {
  assert.equal(evaluateMachineRules("来週火曜日は空いていますか？")?.action, "escalate");
  assert.equal(evaluateMachineRules("11月5日は何時がご都合よろしいですか？")?.action, "escalate");
});

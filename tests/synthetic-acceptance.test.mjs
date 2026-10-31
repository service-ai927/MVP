import test from "node:test";
import assert from "node:assert/strict";
import { evaluateMachineRules, evaluateContentGate } from "../src/rules-engine.mjs";

// Synthetic acceptance matrix: fictional messages only; no client or prospect data.
// Each case checks the expected top-level triage decision and, where applicable,
// the human-review/skip category.
const triageCases = [
  ["meeting date coordination", "来週の打ち合わせの日程を相談できますか？", "escalate", "日程・MTGの日時"],
  ["dated availability question", "来週火曜日は空いていますか？", "escalate", "日程・MTGの日時"],
  ["specific date and time proposal", "15日18時にお願いできませんか？", "escalate", "日程・MTGの日時"],
  ["historical meeting thanks", "打ち合わせありがとうございました。とても参考になりました。", null, null],
  ["past publication date", "9/15に公開した機能の進捗を共有します。", null, null],
  ["daily routine duration", "毎日1時間ずつ作業しています。", null, null],
  ["clock time in a completed update", "今日は10時に投稿しました。", null, null],
  ["explicit pricing discussion", "報酬の単価と契約条件を相談したいです", "escalate", "金額・条件・契約"],
  ["active contract change", "契約条件を変更できるか確認したいです", "escalate", "金額・条件・契約"],
  ["completed contract mention", "先日、契約が完了しました。", null, null],
  ["metric growth advice", "登録者数を増やしたいんですが、何をすればいいですか？", null, null],
  ["performance numbers question", "アプリのダウンロード数はどのくらいですか？", "escalate", "実績の数字を聞かれている"],
  ["metric amount is not money", "フォロワー数は3万まで伸びました。", null, null],
  ["bare commercial amount", "3万でお願いします。", "escalate", "金額・条件・契約"],
  ["complaint", "対応について苦情があります。", "escalate", "断り・クレーム・こじれ"],
  ["refund request", "返金について相談したいです。", "escalate", "断り・クレーム・こじれ"],
  ["former colleague contact", "お久しぶりです。元同僚の件で連絡しました。", "escalate", "知り合い・元同僚からの連絡"],
  ["ordinary greeting", "こんにちは。投稿を拝見しました。", null, null],
  ["ordinary thanks", "ご連絡ありがとうございます。参考になりました。", null, null],
  ["explicit no-reply request", "返信不要です。またこちらからご連絡します。", "skip", "その他・不明"],
  ["promotional blast", "【期間限定】初月無料のSNS運用代行キャンペーン", "skip", "業者の一斉営業"],
  ["URL-only message", "https://example.com/landing", "skip", "リンクだけのDM"],
  ["technical asynchronous wording", "非同期処理の同期設計について質問があります。", null, null],
  ["blank message", "", "skip", "Spam"],
];

test("synthetic acceptance: 24 fictional inbound-message triage scenarios", async (t) => {
  for (const [name, message, expectedAction, expectedCategory] of triageCases) {
    await t.test(name, () => {
      const result = evaluateMachineRules(message);
      if (expectedAction === null) {
        assert.equal(result, null);
        return;
      }
      assert.equal(result?.action, expectedAction);
      assert.equal(result?.category, expectedCategory);
    });
  }
});

const draftCases = [
  ["neutral acknowledgement is allowed", "ご連絡ありがとうございます。参考になりましたら幸いです。", true],
  ["duration is not a time commitment", "お待たせして2時間すみません。", true],
  ["metric quantity is not a price", "フォロワー数は5万まで伸びました。", true],
  ["deliverable promise is blocked", "初稿を作成してお送りします。", false],
  ["specific date is blocked", "11月5日にご連絡します。", false],
  ["clock time is blocked", "15時にお願いします。", false],
  ["price is blocked", "費用は5万円です。", false],
  ["external URL is blocked", "こちらをご覧ください https://example.com", false],
];

test("synthetic acceptance: 8 fictional draft content-gate scenarios", async (t) => {
  for (const [name, draft, expectedPassed] of draftCases) {
    await t.test(name, () => {
      assert.equal(evaluateContentGate(draft).passed, expectedPassed);
    });
  }
});

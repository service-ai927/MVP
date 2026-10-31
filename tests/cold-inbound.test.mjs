import test from "node:test";
import assert from "node:assert/strict";

// Fictional messages only. No key: nothing leaves the machine.
delete process.env.GEMINI_API_KEY;

const { evaluateMachineRules } = await import("../src/rules-engine.mjs");
const { triageThread } = await import("../src/ai-service.mjs");
const { summarizeHandlingTimes } = await import("../src/handling-time.mjs");
const { buildEvaluationReport } = await import("../scripts/evaluate-week.mjs");

const COLD = { hasPriorOutgoing: false };
const ONGOING = { hasPriorOutgoing: true };

// The 10/15-21 evaluation: most machine-rule corrections were 要確認→返信不要.
const coldNoReply = [
  ["vendor pitch mentioning a fee", "はじめまして！弊社ではSNSのフォロワー増加支援をしております。月額料金も業界最安水準です。ご興味あればお気軽にご返信ください。"],
  ["vendor pitch proposing a meeting", "突然のご連絡失礼します。株式会社サンプルの田中と申します。マーケティング支援サービスについて、一度オンラインでお打ち合わせできますか？"],
  ["referral pitch with commission", "インフルエンサー案件のご紹介です。成果報酬型で手数料は不要です。詳細はプロフィールのリンクから。"],
  ["bracketed promotion", "【ご案内】フォロワー1000人保証プラン、今だけ半額で提供中です！"],
  ["get-rich spam", "仮想通貨で月30万稼げる方法を無料で教えます。興味ある方はDMください"],
  ["mutual follow request", "相互フォローお願いします！"],
  ["english spam", "Hi dear, I am interested in your profile, check my bio"],
  ["follow thanks only", "フォローありがとうございます！これからよろしくお願いします🙏"],
  ["cheering only", "いつも投稿見てます！応援してます！"],
  ["link announcement", "新しい動画を公開しました！ぜひ見てください https://example.com/v"],
];

test("cold no-reply messages are skipped before escalation rules fire", async (t) => {
  for (const [name, text] of coldNoReply) {
    await t.test(name, () => {
      assert.equal(evaluateMachineRules(text, COLD)?.action, "skip");
    });
  }
});

const mustNotSkip = [
  ["prospect with a budget (cold)", "はじめまして。株式会社サンプルです。ゲームのマーケティングをお願いしたいのですが、予算は30万円ほどで可能でしょうか？", COLD, "escalate"],
  ["prospect asking for advice (cold)", "遅くにすみません。マーケティングの投稿を見て相談したくDMしました。", COLD, null],
  ["acquaintance with follow thanks (cold)", "お久しぶりです！フォローありがとうございます", COLD, "escalate"],
  ["counterpart describes own product (ongoing)", "弊社のサービスは無料プランもあって、詳細はプロフィールに載せています。", ONGOING, null],
  ["follow thanks inside a conversation (ongoing)", "フォローありがとうございます！", ONGOING, null],
  ["question with a link (cold)", "このページの導線、どこを直すべきでしょうか？ https://example.com/lp", COLD, null],
];

test("prospects, acquaintances, and ongoing conversations are never skipped by cold rules", async (t) => {
  for (const [name, text, context, expected] of mustNotSkip) {
    await t.test(name, () => {
      const result = evaluateMachineRules(text, context);
      assert.notEqual(result?.action, "skip");
      assert.equal(result?.action ?? null, expected);
    });
  }
});

test("without thread context the cold rules stay off", () => {
  assert.notEqual(evaluateMachineRules("相互フォローお願いします！")?.action, "skip");
});

test("pure acknowledgment of our last reply is 返信不要, not an auto draft", async () => {
  const result = await triageThread({
    messages: [
      { from: "me", text: "では、その方向で試してみてください。" },
      { from: "counterpart", text: "了解です！" },
    ],
  });
  assert.equal(result.classification.action, "skip");
  assert.equal(result.draft.generated, null);
});

test("template decisions are labelled fallback, never counted as machine rules", async () => {
  const result = await triageThread({ messages: [{ from: "counterpart", text: "例の件、どう思われますか" }] });
  assert.equal(result.classification.decided_by, "fallback");
  const drafted = await triageThread({ messages: [{ from: "counterpart", text: "Steamのウィッシュリストを増やすにはどうすればいいですか？" }] });
  assert.equal(drafted.classification.decided_by, "fallback");
  assert.equal(drafted.draft.generator, "template_fallback");
  assert.match(drafted.draft.generated, /ウィッシュリスト/);
});

test("handling-time summary separates the manual baseline from MVP-assisted time", () => {
  const rec = (seconds, mode, at) => ({ seconds, mode, at });
  const threads = [
    ...Array.from({ length: 11 }, (_, i) => ({
      handling_time_records: [rec(100 + i, "manual", `2026-11-0${1 + (i % 9)}T0${i % 10}:00:00Z`)],
    })),
    { handling_time_records: [rec(20, "mvp", "2026-11-02T00:00:00Z"), rec(10, "mvp", "2026-11-02T00:05:00Z")] },
    { handling_time_records: [rec(40, "mvp", "2026-11-03T00:00:00Z")] },
    { handling_time_seconds: 999 }, // legacy record without timestamps
  ];
  const all = summarizeHandlingTimes(threads);
  assert.equal(all.manualBaseline.items, 10); // first 10 only
  assert.equal(all.manualBaseline.sampleComplete, true);
  assert.equal(all.mvpAssisted.items, 3); // includes legacy when unscoped

  const windowed = summarizeHandlingTimes(threads, {
    start: new Date("2026-11-01T00:00:00Z"),
    end: new Date("2026-11-10T00:00:00Z"),
  });
  assert.deepEqual([windowed.mvpAssisted.items, windowed.mvpAssisted.meanSeconds], [2, 35]); // 30 + 40, legacy excluded
  assert.ok(windowed.reductionPercent > 60);
});

test("weekly report uses in-app manual timings and the per-source breakdown", () => {
  const reviewed = (decidedBy, from, to) => ({
    thread: { id: `${decidedBy}-${from}-${to}-${Math.random()}` },
    original_classification: { action: from, category: "c", decided_by: decidedBy },
    classification: { action: to, category: "c", decided_by: "human" },
    human_reviewed_at: "2026-11-02T00:00:00Z",
    human_reviewed_via: "update_classification",
  });
  const threads = [
    reviewed("rule", "escalate", "skip"),
    reviewed("llm", "auto", "auto"),
    ...Array.from({ length: 10 }, (_, i) => ({
      thread: { id: `m${i}` },
      handling_time_records: [{ seconds: 120, mode: "manual", at: `2026-11-02T0${i}:00:00Z` }],
    })),
    { thread: { id: "a" }, handling_time_records: [{ seconds: 30, mode: "mvp", at: "2026-11-02T00:00:00Z" }] },
  ];
  const report = buildEvaluationReport({ threads }, "2026-11-01T00:00:00Z", "2026-11-08T00:00:00Z");
  assert.equal(report.classification.headline.ratePercent, 50);
  assert.equal(report.classification.breakdown.bySource.rule.ratePercent, 100);
  assert.equal(report.classification.breakdown.bySource.llm.ratePercent, 0);
  assert.deepEqual(report.classification.breakdown.transitions, { "escalate→skip": 1 });
  assert.equal(report.handlingTime.source, "in-app-manual-mode");
  assert.equal(report.handlingTime.sampleComplete, true);
  assert.equal(report.mvpAssistedHandlingTime.reductionPercentVsManualBaseline, 75);
});

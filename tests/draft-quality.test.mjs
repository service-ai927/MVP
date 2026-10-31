import test from "node:test";
import assert from "node:assert/strict";

// These tests exercise the deterministic fallback pipeline. Removing the key
// before any call guarantees no request ever leaves the machine (the client's
// conversations must never be sent to an external service from tests).
delete process.env.GEMINI_API_KEY;

const { triageThread, generateCustomDraft } = await import("../src/ai-service.mjs");
const { evaluateContentGate } = await import("../src/rules-engine.mjs");

function threadWith(text) {
  return {
    counterpart: { id: "相手X", handle: "@userX", profile_url: "", memo: "" },
    medium: { type: "x", account: "Lily" },
    thread: { id: "x-X", last_incoming_at: "2026-09-07T17:39:00+09:00", status: "open" },
    messages: [{ from: "counterpart", text, at: "2026-09-07T17:39:00+09:00" }],
  };
}

function assertUsableDraft(result) {
  assert.equal(result.classification.action, "auto");
  assert.ok(result.draft.generated, "expected a generated draft");
  assert.ok(result.draft.generated.trim().length > 0, "draft must not be empty");
  const gate = evaluateContentGate(result.draft.generated);
  assert.equal(gate.passed, true, `draft must pass the content gate: ${gate.gate}`);
  assert.equal(result.draft.gate, "合格");
  assert.equal(result.draft.send_status, "held_for_human"); // human approval still required
}

test("gratitude message produces a usable, gate-passing draft in every tone", async () => {
  for (const tone of ["warm", "concise", "professional", "consultative"]) {
    const result = await triageThread(threadWith("助言、ありがとうございます✨"), { tone });
    assert.equal(result.classification.category, "お礼への返信");
    assertUsableDraft(result);
  }
});

test("progress message produces a usable draft", async () => {
  const result = await triageThread(
    threadWith("課金画面のスクショ送ります。3つ以上選ぶ場合は別画面に誘導します。")
  );
  assert.equal(result.classification.category, "進捗報告");
  assertUsableDraft(result);
});

test("growth/how-to question is answered with advice instead of being escalated", async () => {
  const result = await triageThread(
    threadWith("登録者数を増やしたいんですが、何をすればいいですか？")
  );
  assert.equal(result.classification.category, "マーケ相談");
  assertUsableDraft(result);
});

test("metric statement is treated as a progress report, not as a money matter", async () => {
  const result = await triageThread(threadWith("フォロワー数は3万まで伸びました。あと少しで目標です。"));
  assert.equal(result.classification.category, "進捗報告");
  assertUsableDraft(result);
});

test("short benign acknowledgment gets a short acknowledgment back", async () => {
  const result = await triageThread(threadWith("了解です！楽しみにしてます。"));
  assert.equal(result.classification.action, "auto");
  assert.equal(result.classification.category, "簡潔な確認返信");
  assertUsableDraft(result);
  assert.ok(result.draft.generated.length <= 30, "ack drafts stay short");
});

test("explicit no-reply request is skipped without a draft", async () => {
  const result = await triageThread(threadWith("返信不要です。またこちらからご連絡します。"));
  assert.equal(result.classification.action, "skip");
  assert.equal(result.draft.generated, null);
  assert.equal(result.draft.send_status, "not_needed");
});

test("sensitive and ambiguous messages are escalated without a draft", async () => {
  const cases = [
    "9/14（月）13〜17時、9/15（火）15〜17時でご都合いかがでしょう？", // scheduling
    "1件あたり◯万円お渡しします。成果報酬でも構いません。", // money
    "ご相談いただいていた件、いったん見送らせてください。", // decline
    "あの件、どうなりますか？", // ambiguous, no fallback match
  ];
  for (const text of cases) {
    const result = await triageThread(threadWith(text));
    assert.equal(result.classification.action, "escalate", `should escalate: ${text}`);
    assert.equal(result.draft.generated, null, `no draft for: ${text}`);
  }
});

test("no-reply message shapes never produce drafts", async () => {
  const cases = [
    "https://example.com/landing", // link only
    "【期間限定】初月無料のSNS運用代行キャンペーン", // blast
    "🙏✨🎉", // emoji only
  ];
  for (const text of cases) {
    const result = await triageThread(threadWith(text));
    assert.equal(result.classification.action, "skip", `should skip: ${text}`);
    assert.equal(result.draft.generated, null);
  }
});

test("every fallback draft passes the content gate across tones and branches", async () => {
  const messages = [
    "参考になりました。ありがとうございます。",
    "ご相談の件、どうすればいいですか？",
    "進捗を共有します。仕様の検証中です。",
    "承知しました。",
  ];
  const tones = ["warm", "concise", "professional", "consultative"];
  for (const text of messages) {
    for (const tone of tones) {
      const result = await triageThread(threadWith(text), { tone });
      if (result.draft.generated) {
        const gate = evaluateContentGate(result.draft.generated);
        assert.equal(gate.passed, true, `${tone} draft failed gate: ${result.draft.generated}`);
      }
    }
  }
});

test("custom draft fallback stays usable when operator guidance contains a URL", async () => {
  const result = await generateCustomDraft(
    threadWith("ご相談の件、よろしくお願いします。"),
    "例: https://example.com/guide を添えて",
    "concise"
  );
  assert.equal(result.ok, true);
  assert.equal(result.gatePassed, true);
  assert.ok(result.draft.trim().length > 0, "guidance with a URL must not empty the draft");
  assert.equal(/https?:\/\//.test(result.draft), false, "draft must not echo the URL");
  assert.equal(result.source, "template_fallback");
});

test("custom draft fallback acknowledges operator guidance without inventing facts", async () => {
  const withGuidance = await generateCustomDraft(threadWith("ご相談の件、よろしくお願いします。"), "短めに");
  assert.ok(withGuidance.draft.includes("短めに"));
  assert.equal(evaluateContentGate(withGuidance.draft).passed, true);

  const withoutGuidance = await generateCustomDraft(threadWith("ご相談の件、よろしくお願いいます。"));
  assert.ok(withoutGuidance.draft.trim().length > 0);
  assert.equal(evaluateContentGate(withoutGuidance.draft).passed, true);
});


test("fallback advice draft reflects the actual incoming topic", async () => {
  const incoming = "ブラウザゲームを公開したいのですが、誰にも気づかれない気がします。何から始めればいいでしょうか？";
  const result = await triageThread(threadWith(incoming));
  assert.equal(result.classification.action, "auto");
  // Answers the actual subject (pre-launch browser game) without quoting the message back.
  assert.ok(result.draft.generated.includes("公開前"));
  assert.equal(result.draft.generated.includes(incoming), false);
  assert.equal(evaluateContentGate(result.draft.generated).passed, true);
});

test("fallback progress draft reflects the specific update without inventing specifications", async () => {
  const incoming = "課金画面のスクショを共有します。3つ以上選ぶ場合は別画面に誘導します。";
  const result = await triageThread(threadWith(incoming));
  assert.equal(result.classification.action, "auto");
  assert.ok(result.draft.generated.includes("課金画面のスクショを共有します"));
  assert.equal(result.draft.generated.includes("仕様を把握"), false);
  assert.equal(evaluateContentGate(result.draft.generated).passed, true);
});


test("contextual fallback does not echo URLs or email addresses", async () => {
  const incoming = "進捗を共有します。詳細はこちら https://example.com/private と contact@example.com です。";
  const result = await triageThread(threadWith(incoming));
  assert.equal(result.classification.action, "auto");
  assert.equal(result.draft.generated.includes("https://"), false);
  assert.equal(result.draft.generated.includes("example.com"), false);
  assert.equal(result.draft.generated.includes("contact@example.com"), false);
  assert.equal(evaluateContentGate(result.draft.generated).passed, true);
});

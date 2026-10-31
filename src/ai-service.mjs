import { GoogleGenAI } from "@google/genai";
import { evaluateMachineRules, evaluateContentGate } from "./rules-engine.mjs";

const MODEL = "gemini-3.8-flash";
const MAX_RETRIES = Math.max(0, Number.parseInt(process.env.GEMINI_MAX_RETRIES ?? "2", 10) || 0);
const RETRY_BASE_MS = 800;
const VALID_ACTIONS = new Set(["auto", "escalate", "skip"]);

let aiClient = null;

function getAiClient() {
  if (!aiClient && process.env.GEMINI_API_KEY) {
    try {
      aiClient = new GoogleGenAI({
        apiKey: process.env.GEMINI_API_KEY,
        httpOptions: {
          headers: {
            "User-Agent": "aistudio-build",
          },
        },
      });
    } catch (e) {
      console.warn("Failed to initialize GoogleGenAI client:", e);
    }
  }
  return aiClient;
}

/**
 * Transient provider failures (rate limit, overload, 5xx) and malformed JSON
 * are retried with exponential backoff. Without retries a single 503 sent the
 * item down the template path, which escalates anything it does not recognise.
 */
function isRetryable(err) {
  if (err instanceof SyntaxError) return true;
  const status = Number(err?.status ?? err?.code ?? err?.response?.status);
  if ([408, 429, 500, 502, 503, 504].includes(status)) return true;
  return /(429|500|502|503|504|UNAVAILABLE|RESOURCE_EXHAUSTED|overloaded|high demand|timeout|ECONNRESET|fetch failed)/i.test(
    String(err?.message ?? "")
  );
}

async function generateJson(ai, prompt) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await ai.models.generateContent({
        model: MODEL,
        contents: prompt,
        config: { responseMimeType: "application/json" },
      });
      return JSON.parse(String(response.text ?? "").trim());
    } catch (err) {
      if (attempt >= MAX_RETRIES || !isRetryable(err)) throw err;
      await new Promise((resolve) => setTimeout(resolve, RETRY_BASE_MS * 2 ** attempt));
    }
  }
}

function latestIncomingText(messages) {
  const counterpartMessages = messages.filter((m) => m.from !== "me");
  return counterpartMessages.length > 0
    ? counterpartMessages[counterpartMessages.length - 1].text
    : messages[messages.length - 1]?.text || "";
}

function formatHistory(messages, limit) {
  return messages
    .slice(-limit)
    .map((m) => `${m.from === "me" ? "自分" : "相手"}: ${m.text}`)
    .join("\n");
}

function toneInstruction(tone) {
  if (tone === "concise") return "短く率直に。1〜2文。";
  if (tone === "professional") return "丁寧なビジネス敬語。ただし硬すぎる定型句は避ける。";
  if (tone === "consultative") return "相談に乗る口調。具体的な提案を1〜2点。";
  return "親しみやすく丁寧な「です・ます」。絵文字は使っても1つまで。";
}

// Shared drafting guide. The examples follow the client's decision examples
// (相手A/B/C good, 相手K bad); the wording is synthetic.
const DRAFT_STYLE_GUIDE = `
返信案の書き方（日本語のXのDMとして自然に）:
- 1文目で、相手の最新メッセージの具体的な内容に触れる。「ご相談ありがとうございます」などの決まり文句だけで始めない。
- 質問には直接答える。会話の内容に根ざした具体的な提案を1〜2点。どの会話にも当てはまる一般論は書かない。
- 進捗報告には、相手が共有した具体的な進捗に触れる。会話にない確認・理解・合意をしたとは書かない。
- 会話履歴で既に伝えた助言や、既に聞いた情報を繰り返さない。続きの会話なら話を一歩進める。
- 通常は2〜3文。お礼や短い報告には短く返す。箇条書き・見出し・過剰な称賛・不要な質問・「いつでもお気軽に」等の締めの定型句は避ける。
- 相手の文章をそのまま引用・復唱しない。
- 会話にある事実だけを使う。過去のやり取り・成果物・日程・金額・実績・約束を作らない。

良い例:
相手「投稿の1行目を変えてみたら反応が少し変わりました。助言ありがとうございます✨」
返信「反応が変わったの、嬉しいですね！手応えのあった1行目は型として残しておくと次も使えます。」

相手「ブラウザ版のゲームを公開しようと思うのですが、何から始めればいいですか？」
返信「公開前に、事前登録かお知らせ用のページを1つ用意しておくのがおすすめです。あわせてXで開発の様子を少しずつ出しておくと、公開時に見てくれる人が増えます。」

悪い例（禁止）:
「LPの初稿と合わせて形をお送りします」→ 成果物の提出を勝手に約束しているためNG。

安全上の禁止事項:
- 成果物の作成・送付を約束しない（「初稿をお送りします」「作成します」など）。
- 具体的な日付・時刻を書かない。
- 料金・金額・報酬に触れない。
- URLやリンクを含めない。
- 分類・確認・エスカレーションなど内部の業務用語を書かない。
`;

/**
 * Asks Gemini to fix a draft that failed the content gate, once. Returns the
 * rewritten text only if it passes the gate; otherwise null.
 */
async function rewriteFailedDraft(ai, draftText, gateReason, historyText) {
  try {
    const parsed = await generateJson(
      ai,
      `
次のDM返信案は安全チェックに通りませんでした。理由: ${gateReason}

会話:
${historyText}

返信案:
"${draftText}"

問題の箇所だけを取り除き、意味と自然さを保ったまま書き直してください。
${DRAFT_STYLE_GUIDE}
厳密なJSONで返してください: { "draft": "書き直した返信文" }
`
    );
    const rewritten = String(parsed?.draft ?? "").trim();
    return rewritten && evaluateContentGate(rewritten).passed ? rewritten : null;
  } catch (err) {
    console.warn("Draft rewrite failed:", err?.message ?? err);
    return null;
  }
}

/**
 * Cold inbound message that hit an escalation rule (e.g. a vendor pitch that
 * mentions 料金 or a meeting). Gemini may only downgrade it to "skip" when it
 * is clearly unsolicited promotion; it can never turn it into an auto reply.
 * Returns true (skip), false (keep escalation), or null (Gemini unavailable).
 */
async function isUnsolicitedPromotion(ai, text) {
  try {
    const parsed = await generateJson(
      ai,
      `
こちらから一度も連絡していない相手から、次のDMが届きました。

"${text}"

これは返信不要の「一方的な営業・勧誘・宣伝・スパム」ですか？
- 業者が自社のサービス・案件・商品を売り込んでいる、勧誘している、一斉送信の宣伝 → true
- 相手がこちらに仕事を依頼したい・相談したい・条件を聞きたい（見込み客）、知人、苦情、こちらへの質問 → false
- 判断がつかない場合は false

厳密なJSONで返してください: { "unsolicited_promotion": true | false, "reason": "日本語で簡潔に" }
`
    );
    return parsed?.unsolicited_promotion === true ? { skip: true, reason: String(parsed.reason || "") } : { skip: false };
  } catch (err) {
    console.warn("Gemini promotion check failed:", err?.message ?? err);
    return null;
  }
}

function ruleResult(ruleMatch) {
  return {
    classification: {
      action: ruleMatch.action,
      category: ruleMatch.category,
      reason: ruleMatch.reason,
      decided_by: "rule",
      rule_hit: ruleMatch.rule_hit,
    },
    draft: {
      generated: null,
      edited: null,
      gate: ruleMatch.action === "skip" ? "-" : "要本人承認",
      send_status: ruleMatch.action === "skip" ? "not_needed" : "held_for_human",
    },
  };
}

/**
 * Executes the three-stage pipeline:
 * Stage 1: Machine Rules (Regex & keyword filters)
 * Stage 2: LLM (Gemini for nuanced classification & reply drafting)
 * Stage 3: Content / Safety Gate (Inspects draft before handing to human operator)
 */
export async function triageThread(thread, options = {}) {
  const messages = thread?.messages || [];
  const lastIncoming = latestIncomingText(messages);
  const hasPriorOutgoing = messages.some((m) => m.from === "me");
  const counterpart = thread?.counterpart || {};
  const tone = options.tone || "warm"; // warm, concise, professional, consultative
  const ai = getAiClient();

  // STAGE 1: Machine Rules Check
  const ruleMatch = evaluateMachineRules(lastIncoming, { hasPriorOutgoing });
  if (ruleMatch) {
    if (ruleMatch.action === "escalate" && !hasPriorOutgoing && ai) {
      const verdict = await isUnsolicitedPromotion(ai, lastIncoming);
      if (verdict?.skip) {
        return {
          classification: {
            action: "skip",
            category: "業者の一斉営業",
            reason: `Geminiが一方的な営業・勧誘と判定（機械ルール「${ruleMatch.rule_hit}」より優先）${verdict.reason ? `: ${verdict.reason}` : ""}`,
            decided_by: "llm",
            rule_hit: ruleMatch.rule_hit,
          },
          draft: { generated: null, edited: null, gate: "-", send_status: "not_needed" },
        };
      }
    }
    return ruleResult(ruleMatch);
  }

  // STAGE 2: LLM Evaluation via Gemini
  if (ai) {
    try {
      const historyText = formatHistory(messages, 8);
      const prompt = `
あなたはアウトリーチ返信管理システムの振り分け担当です。

相手の情報:
名前: ${counterpart.id || "不明"}
ハンドル: ${counterpart.handle || ""}
内部メモ: ${counterpart.memo || "なし"}
こちらからの送信履歴: ${hasPriorOutgoing ? "あり" : "なし（相手からの初回連絡）"}

会話履歴（新しい順ではなく時系列）:
${historyText}

相手の最新メッセージ:
"${lastIncoming}"

タスク:
1. action を決める:
   - "auto": AIの返信案で対応できる（助言・お礼への返信・通常のやり取り・約束を伴わない進捗報告への返信）。
   - "escalate": 本人の判断が必要（日程調整、金額・条件・契約、断り・クレーム、知人・元同僚、こちらの実績の数字を聞かれている、情報不足で責任を持って返せない）。
   - "skip": 返信不要（営業・勧誘・宣伝・スパム、リンクだけ、相手が返信不要と明示、こちらの返信に対する「了解です」「承知しました」だけで答える内容がない、会話が自然に終わっている）。
   会議・契約・日付・数字に触れているだけで escalate にしない。本人が実際に決める必要がある場合だけ escalate にする。
   迷った場合の優先: 安全に返せる通常のやり取りは auto、売り込み・一斉送信は skip、本当に判断が必要なものだけ escalate。
2. category: 短いカテゴリ名（例: "お礼への返信", "マーケ相談", "進捗報告", "動画相談", "カジュアルな質問", "業者の一斉営業", "会話の区切り"）。
3. reason: その判断の理由を日本語で簡潔に。
4. action が "auto" の場合のみ、返信案を書く。文体: ${toneInstruction(tone)}
${DRAFT_STYLE_GUIDE}

厳密なJSONで返してください:
{
  "action": "auto" | "escalate" | "skip",
  "category": "string",
  "reason": "string",
  "draft": "string または null"
}
`;

      const parsed = await generateJson(ai, prompt);

      let action = VALID_ACTIONS.has(parsed?.action) ? parsed.action : "escalate";
      const category = String(parsed?.category || "").trim() || "その他・不明";
      let reason = String(parsed?.reason || "").trim() || "Geminiによる判定";
      let draftText = action === "auto" ? String(parsed?.draft || "").trim() || null : null;

      // STAGE 3: Content Gate
      let gate = "-";
      let sendStatus = action === "skip" ? "not_needed" : "held_for_human";

      if (action === "auto" && !draftText) {
        action = "escalate";
        reason = `${reason}（返信案が生成されなかったため確認へ）`;
      } else if (action === "auto") {
        const gateCheck = evaluateContentGate(draftText);
        gate = gateCheck.gate;
        if (!gateCheck.passed) {
          const rewritten = await rewriteFailedDraft(ai, draftText, gateCheck.reason, historyText);
          if (rewritten) {
            draftText = rewritten;
            gate = "合格";
          } else {
            // Do not surface a draft that failed the content gate.
            action = "escalate";
            draftText = null;
            reason = `${reason} (文面ゲート要確認: ${gateCheck.reason})`;
          }
        }
      }

      return {
        classification: {
          action,
          category,
          reason,
          decided_by: "llm",
          rule_hit: null,
        },
        draft: {
          generated: draftText,
          edited: null,
          gate,
          send_status: sendStatus,
          generator: draftText ? "gemini" : null,
        },
      };
    } catch (err) {
      console.warn("Gemini LLM call failed after retries, using template fallback:", err?.message ?? err);
    }
  }

  // Template fallback when Gemini is not configured or unavailable. Recorded
  // as decided_by "fallback" so it is never counted as a machine-rule decision.
  return fallbackHeuristics(lastIncoming, tone, { hasPriorOutgoing, geminiConfigured: Boolean(ai) });
}

/**
 * Tone-aware template picker. consultative shares the professional wording.
 */
function pickToneVariant(tone, variants) {
  if (tone === "concise") return variants.concise;
  if (tone === "professional" || tone === "consultative") return variants.professional;
  return variants.warm;
}

function fallbackNote(env) {
  return env.geminiConfigured ? "（Gemini応答なし・テンプレート判定）" : "（テンプレート判定）";
}

function fallbackResult(action, category, reason, env, draftText = null) {
  return {
    classification: {
      action,
      category,
      reason: `${reason}${fallbackNote(env)}`,
      decided_by: "fallback",
      rule_hit: null,
    },
    draft: {
      generated: draftText,
      edited: null,
      gate: draftText ? "合格" : action === "skip" ? "-" : "要確認",
      send_status: action === "skip" ? "not_needed" : "held_for_human",
      generator: draftText ? "template_fallback" : null,
    },
  };
}

/**
 * Builds an "auto" fallback result. Every template draft is validated by the
 * same content gate as LLM drafts; a failing template escalates instead of
 * surfacing an unsafe reply.
 */
function fallbackAutoResult(category, reason, draftText, env) {
  if (!evaluateContentGate(draftText).passed) {
    return fallbackResult(
      "escalate",
      "要本人判断",
      "定型文が文面ゲートを通過できなかったため、オペレーターの目視確認にルーティング",
      env
    );
  }
  return fallbackResult("auto", category, reason, env, draftText);
}

function safeContextSnippet(text, maxLength = 48) {
  return String(text || "")
    .replaceAll("\n", " ")
    .replaceAll("\t", " ")
    .split(" ")
    .filter((part) => !part.startsWith("http://") && !part.startsWith("https://") && !part.includes("@"))
    .join(" ")
    .trim()
    .slice(0, maxLength);
}

/**
 * Short, question-free acknowledgments ("了解です！楽しみにしてます。").
 * Anything with a question stays on the conservative default (escalate / LLM).
 */
function isBenignAcknowledgment(text) {
  const trimmed = (text || "").trim();
  if (!trimmed || trimmed.length > 60) return false;
  if (/[?？]|ですか|ませんか|でしょうか|どう|いつ|いくら|どの|どれ|教えて|なぜ/.test(trimmed)) {
    return false;
  }
  return /(了解|承知しました|かしこまりました|わかりました|お疲れ様|楽しみにして|助かりました|助かります)/.test(
    trimmed
  );
}

const ASKS_FOR_ADVICE = /[?？]|ですか|でしょうか|ますか|たい|教えて|相談|アドバイス|おすすめ|どうすれば|何から|何をすれば|どうやって/;

// Topic-specific advice so a template draft still answers the actual subject.
const ADVICE_BY_TOPIC = [
  [/steam|ウィッシュリスト/i, "Steamならストアページを早めに公開して、開発の様子をXで定期的に出しながらウィッシュリスト登録を呼びかけるのが効果的です。"],
  [/事前登録|公開前|リリース前|公開しよう|公開したい|ローンチ|ブラウザ/, "公開前に事前登録かお知らせ用のページを用意して、開発の様子をXで少しずつ発信しておくと、公開時に見てもらえる人を増やせます。"],
  [/動画|ショート|tiktok|youtube|リール/i, "動画は冒頭の数秒で一番面白い場面を見せて、反応の良かった構成を次の動画でも試していくのがおすすめです。"],
  [/投稿|ツイート|ポスト|フォロワ|インプレ/, "投稿は1行目で何の話か伝わるようにして、反応の良かった型を残しながら少しずつ変えていくのがおすすめです。"],
  [/ページ|ランディング|導線/, "ページは最初の画面で誰向けの何かが伝わるようにして、登録や問い合わせへの導線を一つに絞るのがおすすめです。"],
];
const DEFAULT_ADVICE = "まずは届けたい相手を一つに絞って小さく試し、反応を見ながら調整していくのがおすすめです。";

function adviceFor(text) {
  return ADVICE_BY_TOPIC.find(([pattern]) => pattern.test(text))?.[1] ?? DEFAULT_ADVICE;
}

/**
 * Template engine adhering to the client's decision examples.
 */
function fallbackHeuristics(text, tone, env) {
  const lower = (text || "").toLowerCase();

  // Pure acknowledgment of our last message: nothing to answer (返信不要).
  if (isBenignAcknowledgment(text) && env.hasPriorOutgoing) {
    return fallbackResult(
      "skip",
      "会話の区切り",
      "こちらの返信に対する短い了承のみで、答える内容がないため返信不要",
      env
    );
  }

  // If acknowledgment or gratitude
  if (/助言|ありがとう|感謝|お礼|thanks|thank you|参考|嬉しい/i.test(lower) && !/[?？]/.test(text)) {
    const draftText = pickToneVariant(tone, {
      warm: "そう言っていただけて嬉しいです！試してみて気になることがあれば、また聞いてください。",
      concise: "お役に立てて良かったです！",
      professional: "ご丁寧にありがとうございます。お役に立てたなら幸いです。引き続きよろしくお願いいたします。",
    });

    return fallbackAutoResult(
      "お礼への返信",
      "助言や前回のやり取りに対するお礼。日程・金額なしのため相槌で返信可能",
      draftText,
      env
    );
  }

  // If progress report or announcement (incl. growth statements like "登録者が伸びました")
  if (/スクショ|進捗|作成中|公開しました|リリースしました|実装|仕様|共有|伸びました|伸びて|達成/i.test(lower) && !/[?？]/.test(text)) {
    const context = safeContextSnippet(String(text || "").split(/[。！!]/)[0], 42);
    const launched = /公開しました|リリースしました/.test(text);
    const reference = context ? `「${context}」という点、把握しました。` : "共有いただいた内容を確認しました。";
    const opener = launched ? "公開おめでとうございます！" : "共有ありがとうございます。";
    const draftText = pickToneVariant(tone, {
      warm: `${opener}${reference}反応が見えてきたら、また教えてください。`,
      concise: `${opener}${reference}`,
      professional: `${launched ? "公開おめでとうございます。" : "共有いただきありがとうございます。"}${reference}引き続きよろしくお願いいたします。`,
    });

    return fallbackAutoResult(
      "進捗報告",
      "進捗や画面の共有への確認。約束事なしのため通常返信可能",
      draftText,
      env
    );
  }

  // Consultation about marketing/games/videos (how-to questions)
  if (/相談|何から|どうすれば|何をすれば|どうやって|アドバイス|おすすめ|教えて|動画|見てもらい|工夫/i.test(lower) && ASKS_FOR_ADVICE.test(text)) {
    // Answer the topic directly instead of quoting the message back.
    const advice = adviceFor(text);
    const draftText = pickToneVariant(tone, {
      warm: `${advice}試してみて反応が見えたら、また教えてください。`,
      concise: advice,
      professional: `ご相談いただきありがとうございます。${advice}`,
    });

    return fallbackAutoResult(
      "マーケ相談",
      "日程・金額の提示なし。実行可能な助言・知見の共有で対応可能",
      draftText,
      env
    );
  }

  // Short benign acknowledgments with no earlier reply from us
  if (isBenignAcknowledgment(text)) {
    const draftText = pickToneVariant(tone, {
      warm: "ご連絡ありがとうございます。承知しました。",
      concise: "承知しました。",
      professional: "ご連絡いただきありがとうございます。承知いたしました。",
    });

    return fallbackAutoResult(
      "簡潔な確認返信",
      "短い確認メッセージ。日程・金額・約束事なしのため相槌で返信可能",
      draftText,
      env
    );
  }

  // Default safe response
  return fallbackResult(
    "escalate",
    "要本人判断",
    "定型外の個別メッセージのため、オペレーターの目視確認にルーティング",
    env
  );
}

/**
 * Regenerate reply draft on demand with custom tone or operator guidance
 */
export async function generateCustomDraft(thread, promptGuidance = "", tone = "warm") {
  const messages = thread?.messages || [];
  const lastIncoming = latestIncomingText(messages);
  const counterpart = thread?.counterpart || {};
  const ai = getAiClient();

  if (ai) {
    try {
      const historyText = formatHistory(messages, 8);
      const prompt = `
アウトリーチ管理ワークフローで、DMの返信案を書いてください。

相手: ${counterpart.id || "不明"} (${counterpart.handle || ""})
内部メモ: ${counterpart.memo || "なし"}

会話:
${historyText}

相手の最新メッセージ:
"${lastIncoming}"

担当者からの指示: ${promptGuidance ? `"${promptGuidance}"` : "なし（自然で役に立つ返信を）"}
文体: ${toneInstruction(tone)}
${DRAFT_STYLE_GUIDE}
担当者の指示が安全上の禁止事項と矛盾する場合は、禁止事項を優先してください。

厳密なJSONで返してください:
{
  "draft": "返信文"
}
`;

      const parsed = await generateJson(ai, prompt);
      let draftText = String(parsed?.draft || "").trim();
      let gateCheck = evaluateContentGate(draftText);
      if (!gateCheck.passed && draftText) {
        const rewritten = await rewriteFailedDraft(ai, draftText, gateCheck.reason, historyText);
        if (rewritten) {
          draftText = rewritten;
          gateCheck = evaluateContentGate(rewritten);
        }
      }

      return {
        ok: true,
        draft: gateCheck.passed ? draftText : "",
        gate: gateCheck.gate,
        gatePassed: gateCheck.passed,
        reason: gateCheck.reason,
        source: "gemini",
      };
    } catch (e) {
      console.warn("Custom draft generation failed:", e?.message ?? e);
    }
  }

  // Fallback: acknowledge the operator's guidance without inventing content.
  // Guidance is sanitized (URLs stripped, capped) so quoting it can never
  // trip the content gate into returning an empty draft.
  const safeGuidance = String(promptGuidance || "")
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
  const concise = tone === "concise";
  const opener = concise ? "ご連絡ありがとうございます。" : "ご連絡いただきありがとうございます。";
  const ack = concise ? "承知しました。" : "承知いたしました。";
  const fallbackText = safeGuidance
    ? `${opener}「${safeGuidance}」の件、${ack}`
    : `${opener}内容を${concise ? "確認しました" : "確認いたしました"}。少しでもお力になれれば幸いです。`;

  const gateCheck = evaluateContentGate(fallbackText);
  return {
    ok: true,
    draft: gateCheck.passed ? fallbackText : "",
    gate: gateCheck.gate,
    gatePassed: gateCheck.passed,
    reason: gateCheck.reason,
    source: "template_fallback",
  };
}

import { GoogleGenAI } from "@google/genai";
import { evaluateMachineRules, evaluateContentGate } from "./rules-engine.mjs";

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
 * Executes the three-stage pipeline:
 * Stage 1: Machine Rules (Regex & keyword filters)
 * Stage 2: LLM (Gemini 3.8 Flash for nuanced classification & reply drafting)
 * Stage 3: Content / Safety Gate (Inspects draft before handing to human operator)
 */
export async function triageThread(thread, options = {}) {
  const messages = thread?.messages || [];
  const counterpartMessages = messages.filter((m) => m.from !== "me");
  const lastIncoming = counterpartMessages.length > 0 
    ? counterpartMessages[counterpartMessages.length - 1].text 
    : (messages[messages.length - 1]?.text || "");
  
  const counterpart = thread?.counterpart || {};
  const tone = options.tone || "warm"; // warm, concise, professional, consultative

  // STAGE 1: Machine Rules Check
  const ruleMatch = evaluateMachineRules(lastIncoming);
  if (ruleMatch) {
    // If rule mandates skip or escalation:
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

  // STAGE 2: LLM Evaluation via Gemini 3.8 Flash
  const ai = getAiClient();
  if (ai) {
    try {
      const historyText = messages
        .slice(-5)
        .map((m) => `${m.from === "me" ? "Me" : "Counterpart"}: ${m.text}`)
        .join("\n");

      const prompt = `
Analyze this conversation thread for an outreach reply management system.

Counterpart Context:
Name: ${counterpart.id || "Unknown"}
Handle: ${counterpart.handle || ""}
Memo/Notes: ${counterpart.memo || "None"}

Conversation History (latest messages):
${historyText}

Latest Incoming Message:
"${lastIncoming}"

Goal:
1. Classify the message into an action:
   - "auto": Can be handled by an AI reply draft (advice, gratitude, routine follow-up, progress update without contractual commitments).
   - "escalate": Requires operator's own judgment (schedule, price, complaint, custom partnership terms).
   - "skip": No response required (spam, unsolicited promo, link only).
2. Category: Short descriptive category (e.g., "お礼への返信", "マーケ相談", "進捗報告", "協業打診", "カジュアルな質問", "動画相談").
3. Reason: Concise explanation of why this action and category were chosen.
4. If action is "auto", generate an appropriate reply draft in the same language (typically Japanese, matching the context).
   Tone guideline: ${tone === "concise" ? "Short, direct, friendly" : tone === "professional" ? "Polite and formal" : "Warm, empathetic, helpful"}.
   CRITICAL SAFETY CONSTRAINTS FOR DRAFT:
   - Do NOT promise future deliverables (do not say "初稿をお送りします", "作成します").
   - Do NOT offer specific dates or times (no "9/15", "◯時").
   - Do NOT quote prices or fees.
   - Do NOT invent external links.

Output format: Return strictly valid JSON with keys:
{
  "action": "auto" | "escalate" | "skip",
  "category": "string",
  "reason": "string",
  "draft": "string or null"
}
`;

      const response = await ai.models.generateContent({
        model: "gemini-3.8-flash",
        contents: prompt,
        config: {
          responseMimeType: "application/json",
        },
      });

      const parsed = JSON.parse(response.text.trim());

      let action = parsed.action || "auto";
      let category = parsed.category || "General inquiry";
      let reason = parsed.reason || "Processed by LLM";
      let draftText = parsed.draft || null;

      // STAGE 3: Content Gate
      let gate = "合格";
      let sendStatus = "held_for_human";

      if (action === "skip") {
        draftText = null;
        gate = "-";
        sendStatus = "not_needed";
      } else if (action === "escalate") {
        draftText = null;
        gate = "-";
        sendStatus = "held_for_human";
      } else if (draftText) {
        const gateCheck = evaluateContentGate(draftText);
        gate = gateCheck.gate;
        if (!gateCheck.passed) {
          // Do not surface a draft that failed the content gate.
          action = "escalate";
          draftText = null;
          reason = `${reason} (文面ゲート要確認: ${gateCheck.reason})`;
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
        },
      };
    } catch (err) {
      console.warn("Gemini LLM call failed or timed out, using fallback heuristics:", err);
    }
  }

  // Graceful rule-based fallback when LLM is unavailable or unauthenticated
  return fallbackHeuristics(lastIncoming, counterpart, tone);
}

/**
 * Intelligent fallback heuristic engine adhering to the client's decision examples
 */
function fallbackHeuristics(text, counterpart, tone) {
  const lower = (text || "").toLowerCase();

  // If acknowledgment or gratitude
  if (/助言|ありがとう|感謝|お礼|thanks|thank you|参考|嬉しい/i.test(lower)) {
    const draftText =
      tone === "concise"
        ? "役に立てて何よりです！引き続き応援しております。"
        : "温かいお言葉をいただきありがとうございます✨ 少しでも参考になりましたら幸いです。また何か気になる点があればいつでも気軽にお声がけください！";

    return {
      classification: {
        action: "auto",
        category: "お礼への返信",
        reason: "助言や前回のやり取りに対するお礼。日程・金額なしのため相槌で返信可能",
        decided_by: "rule",
        rule_hit: null,
      },
      draft: {
        generated: draftText,
        edited: null,
        gate: "合格",
        send_status: "held_for_human",
      },
    };
  }

  // If consulting about advice/marketing/games
  if (/相談|何から|どうすれば|アドバイス|おすすめ|教えて|動画|見てもらい|工夫/i.test(lower)) {
    const draftText =
      "ご相談ありがとうございます！まずは小さく検証できる部分から手をつけるのがおすすめです。ターゲットとなるユーザーやコミュニティに向けて定期的に進捗を発信し、反応を確かめながら進めてみてください。";

    return {
      classification: {
        action: "auto",
        category: "マーケ相談",
        reason: "日程・金額の提示なし。実行可能な助言・知見の共有で対応可能",
        decided_by: "rule",
        rule_hit: null,
      },
      draft: {
        generated: draftText,
        edited: null,
        gate: "合格",
        send_status: "held_for_human",
      },
    };
  }

  // If progress report
  if (/スクショ|進捗|作成中|公開|実装|仕様|共有/i.test(lower)) {
    const draftText =
      "共有ありがとうございます！仕様と現在の進行状況を把握いたしました。この方向性で進めてまいりましょう。";

    return {
      classification: {
        action: "auto",
        category: "進捗報告",
        reason: "進捗や画面の共有への確認。約束事なしのため通常返信可能",
        decided_by: "rule",
        rule_hit: null,
      },
      draft: {
        generated: draftText,
        edited: null,
        gate: "合格",
        send_status: "held_for_human",
      },
    };
  }

  // Default safe response
  return {
    classification: {
      action: "escalate",
      category: "要本人判断",
      reason: "定型外の個別メッセージのため、オペレーターの目視確認にルーティング",
      decided_by: "rule",
      rule_hit: null,
    },
    draft: {
      generated: null,
      edited: null,
      gate: "要確認",
      send_status: "held_for_human",
    },
  };
}

/**
 * Regenerate reply draft on demand with custom tone or operator guidance
 */
export async function generateCustomDraft(thread, promptGuidance = "", tone = "warm") {
  const messages = thread?.messages || [];
  const counterpartMessages = messages.filter((m) => m.from !== "me");
  const lastIncoming = counterpartMessages.length > 0 
    ? counterpartMessages[counterpartMessages.length - 1].text 
    : (messages[messages.length - 1]?.text || "");
  
  const counterpart = thread?.counterpart || {};
  const ai = getAiClient();

  if (ai) {
    try {
      const historyText = messages
        .slice(-6)
        .map((m) => `${m.from === "me" ? "Me" : "Counterpart"}: ${m.text}`)
        .join("\n");

      const prompt = `
You are drafting a reply message for an outreach management workflow.

Context:
Counterpart Name: ${counterpart.id || "Unknown"} (${counterpart.handle || ""})
Internal Note: ${counterpart.memo || "None"}

Thread:
${historyText}

Latest Message from Counterpart:
"${lastIncoming}"

Operator Instructions:
${promptGuidance ? `Special instruction: "${promptGuidance}"` : "Generate a polite, helpful reply."}
Tone: ${tone} (Options: warm, professional, concise, consultative)

SAFETY RULES (MANDATORY):
1. Do NOT make unauthorized promises to deliver work by a certain date.
2. Do NOT mention specific dates or hours.
3. Do NOT mention pricing or money amounts.
4. Keep within 2-4 natural sentences.

Output strictly valid JSON:
{
  "draft": "the reply text"
}
`;

      const response = await ai.models.generateContent({
        model: "gemini-3.8-flash",
        contents: prompt,
        config: {
          responseMimeType: "application/json",
        },
      });

      const parsed = JSON.parse(response.text.trim());
      const draftText = parsed.draft || "";
      const gateCheck = evaluateContentGate(draftText);

      return {
        ok: true,
        draft: gateCheck.passed ? draftText : "",
        gate: gateCheck.gate,
        gatePassed: gateCheck.passed,
        reason: gateCheck.reason,
        source: "gemini",
      };
    } catch (e) {
      console.warn("Custom draft generation failed:", e);
    }
  }

  // Fallback
  const fallbackText = promptGuidance 
    ? `ご連絡ありがとうございます。${promptGuidance}の件、承知いたしました。引き続きどうぞよろしくお願いいたします。`
    : `ご連絡いただきありがとうございます！内容をしっかり確認いたしました。少しでもお力になれれば幸いです。`;

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

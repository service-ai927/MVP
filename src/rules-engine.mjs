/**
 * Machine Rules Engine & Safety Content Gate
 * Grounded in the client's criteria and decision examples.
 */

// Machine escalation rules (例外なく本人判断)
export const ESCALATION_RULES = [
  {
    name: "日程・MTGの日時",
    category: "日程・MTGの日時",
    reason: "機械ルール: 日程・MTGの日時（例外なく本人判断）",
    test: (text) => {
      // Escalate actual coordination intent, not every historical mention of
      // a meeting, calendar, date, or time. This avoids false positives such
      // as "打ち合わせありがとうございました" and progress updates.
      const hasDateOrClock =
        /(?:^|[^0-9])\d{1,2}[/／]\d{1,2}(?:日)?|\d{1,2}月\d{1,2}日|\d{1,2}[:：]\d{2}|\d{1,2}時(?!間)/.test(text) ||
        /(?:月|火|水|木|金|土|日)曜(?:日)?/.test(text);
      const directCoordination =
        /(日程(?:調整|候補|を|について)|ご都合|空き時間|空いて(?:る|います|おります)|リスケ|予定を合わせ|日時を|日付を決め|候補日)/.test(text);
      const meetingProposal =
        /(打ち合わせ|ミーティング|MTG|面談|zoom|google\s?meet)/i.test(text) &&
        /(できますか|可能でしょうか|可能ですか|お願いできますか|お願いできませんか|いかがでしょう|いかがですか|しましょう|お時間をいただ|ご参加いただ|調整したい|設定したい)/.test(text);
      const dateProposal = hasDateOrClock && /(お願いできますか|お願いできませんか|可能でしょうか|可能ですか|いかがでしょう|いかがですか|空いて(?:る|います|おります)|何時が|いつが)/.test(text);
      return directCoordination || (hasDateOrClock && meetingProposal) || dateProposal;
    },
  },
  {
    name: "金額・条件・契約",
    category: "金額・条件・契約",
    reason: "機械ルール: 金額・条件・契約（例外なく本人判断）",
    test: (text) => {
      // Escalate active commercial decisions, not passive mentions of a
      // completed contract or a past invoice. Concrete money/price terms and
      // explicit negotiation/quotation requests remain operator-owned.
      const explicitCommercialTerm =
        /(単価|見積(?:もり)?|請求|予算|費用|料金|金額|報酬|◯万円?|成果報酬|固定額|成約|手数料)/i.test(text);
      const contractDecision =
        /(契約|発注|受託|条件)/i.test(text) &&
        /(相談|確認したい|確認できますか|変更|交渉|結びたい|お願い|可能でしょうか|いかが|どうでしょう|検討)/.test(text);
      if (explicitCommercialTerm || contractDecision) return true;
      // A bare "N万" escalates too, unless the number is clearly a metric
      // ("フォロワー数は3万まで伸びました") rather than money. The client's
      // criterion is written as "◯万円"; non-metric 万 stays conservative.
      const metricContext =
        /フォロワ|ユーザー|登録者|会員数|再生回数|再生数|視聴|インプレッション|表示回数|クリック|エンゲージ|閲覧|ダウンロード|DL数/i;
      const wanPattern = /\d+(?:\.\d+)?万(?:円)?/g;
      let match;
      while ((match = wanPattern.exec(text)) !== null) {
        const around = text.slice(
          Math.max(0, match.index - 12),
          match.index + match[0].length + 8
        );
        if (!metricContext.test(around)) return true;
      }
      return false;
    },
  },
  {
    name: "実績の数字を聞かれている",
    category: "実績の数字を聞かれている",
    reason: "機械ルール: 実績の数字（DL数・売上等）は機械が答えない",
    test: (text) => {
      // Escalate when performance numbers are actually being *asked for*
      // ("どのくらいダウンロードされてますか？"). A keyword alone is not
      // enough: growth/how-to statements ("登録者数を増やしたいんです") are
      // marketing conversations, not asks for our numbers. The LLM prompt
      // (ai-service.mjs) still escalates genuine metrics questions, so the
      // narrowed rule only stops false short-circuit escalations.
      const asksAboutNumbers =
        /(どのくらい|いかが|いくつ|何件|何人|教えて|見せて|差し支えなければ|実績は|数字は)/.test(
          text
        );
      const seeksGuidance =
        /(増や|伸ば|改善|方法|コツ|どうすれば|どうやって|何をすれば|相談)/.test(text);
      return (
        /(ダウンロード|DL数|売上|月商|年商|PV数|ユーザー数|登録者数|実績の数字)/i.test(text) &&
        asksAboutNumbers &&
        !seeksGuidance
      );
    },
  },
  {
    name: "断り・クレーム・こじれ",
    category: "断り・クレーム・こじれ",
    reason: "機械ルール: 断り・クレーム。返し方は本人が決める",
    test: (text) => {
      return /(見送らせて|見送り|辞退|クレーム|苦情|返金|迷惑|怒って|不満|対応に納得|解約)/i.test(
        text
      );
    },
  },
  {
    name: "知り合い・元同僚からの連絡",
    category: "知り合い・元同僚からの連絡",
    reason: "機械ルール: 知人・元同僚。関係性の文脈に応じた本人対応",
    test: (text) => {
      // Guard against technical terms like "同期設計" or "非同期"
      if (/同期(設計|処理|通信)|非同期/.test(text)) {
        return false;
      }
      return /(お久しぶり|ご無沙汰|昔一緒|元同僚|会社の同期|学生時代)/i.test(text);
    },
  },
];

// Signals for unsolicited, cold inbound messages (no earlier message from us).
// The 10/15-21 evaluation showed most machine-rule corrections were
// "要確認 → 返信不要": vendor pitches mention prices, fees, or meetings and
// tripped the escalation rules. These signals let skip rules catch them first.
// They apply only to cold threads so an ongoing conversation is never skipped
// because the counterpart describes their own product.
const COLD_OPENER = /(突然のご連絡|突然のDM|突然失礼|初めてご連絡|はじめまして|初めまして)/;
const SELF_PROMOTION = /(弊社|当社|弊店|私どもは|株式会社|合同会社|有限会社|運営事務局|と申します)/;
const OFFER =
  /(ご案内|ご紹介|サービス|プラン|無料|半額|割引|特典|期間限定|今だけ|キャンペーン|保証|モニター募集|提供中|提供して|代行|集客|フォロワー(?:を)?増|導入|案件のご紹介|副業|稼げ|稼ぐ)/;
const CALL_TO_ACTION =
  /(詳細は|詳しくは|お気軽に|ご興味|ご返信ください|DMください|プロフ|bio|リンク|LINE|公式アカウント|ご登録|お問い合わせ|こちらから)/i;
const STRONG_SPAM =
  /(相互フォロー|フォロバ(?:お願い|して|100)|稼げる方法|不労所得|仮想通貨で|FXで|高収入|在宅ワーク|フォロワー(?:購入|\d+人保証)|check my (?:bio|profile)|dm me|hi dear|hello dear|crypto|forex|investment opportunity)/i;
// The counterpart asks *us* for help: a prospect, never a pitch.
const ASKS_US =
  /(相談したく|相談したい|ご相談させて|お願いしたい|依頼したい|お伺いしたい|教えていただけ|教えてください|お聞きしたい|お話を伺いたい|見ていただけ|見てもらえ)/;
// Reaction-only messages: follow thanks, cheering, a greeting with nothing to answer.
const REACTION_ONLY =
  /(フォロー(?:ありがとう|しました|させていただきました)|フォローバックありがとう|応援して(?:い)?ます|いつも(?:投稿)?(?:見て|拝見して)(?:い)?ます|ファンです)/;
const ASKS_SOMETHING = /[?？]|ですか|ませんか|でしょうか|ますか|教えて|相談|お願いしたい/;

function isCold(context) {
  return context?.hasPriorOutgoing === false;
}

function looksLikeUnsolicitedPitch(text) {
  if (STRONG_SPAM.test(text)) return true;
  if (ASKS_US.test(text)) return false;
  const offer = OFFER.test(text);
  if (!offer) return false;
  if (SELF_PROMOTION.test(text)) return true;
  return (
    CALL_TO_ACTION.test(text) &&
    (COLD_OPENER.test(text) || /【[^】]+】/.test(text) || /(ご紹介です|ご案内です|募集中|募集しています|提供中)/.test(text))
  );
}

// Machine skip rules (返信不要と判定)
export const SKIP_RULES = [
  {
    name: "業者の一斉営業",
    category: "業者の一斉営業",
    reason: "返信不要と判定: 一斉配信の定型（罫線・▼・キャンペーン等）",
    test: (text) => {
      return (
        /━{4,}|─{4,}|＝{4,}/.test(text) ||
        /(【期間限定|【PR】|【広告】|特別キャンペーン|初月無料|SNS運用代行|集客自動化|▼登録はこちら|▼詳細はこちら)/i.test(text)
      );
    },
  },
  {
    name: "初回の営業・勧誘",
    category: "業者の一斉営業",
    reason: "返信不要と判定: こちらから連絡していない相手からの営業・勧誘・スパム",
    test: (text, context) => isCold(context) && looksLikeUnsolicitedPitch(text),
  },
  {
    name: "挨拶・リアクションのみ",
    category: "挨拶・リアクションのみ",
    reason: "返信不要と判定: 初回のフォロー礼・応援など、答える内容のない短いメッセージ",
    test: (text, context) =>
      isCold(context) &&
      text.trim().length <= 60 &&
      REACTION_ONLY.test(text) &&
      !ASKS_SOMETHING.test(text) &&
      !/(お久しぶり|ご無沙汰|元同僚|昔一緒|学生時代)/.test(text),
  },
  {
    name: "リンク付きの告知のみ",
    category: "リンクだけのDM",
    reason: "返信不要と判定: こちらから連絡していない相手からのリンク付き告知",
    test: (text, context) => {
      if (!isCold(context) || !/https?:\/\/\S+/.test(text)) return false;
      const withoutUrls = text.replace(/https?:\/\/\S+/g, "").trim();
      return withoutUrls.length <= 40 && !ASKS_SOMETHING.test(withoutUrls);
    },
  },
  {
    name: "他サービスへの誘導だけ",
    category: "リンクだけのDM",
    reason: "返信不要と判定: 他サービスへの誘導リンクのみ",
    test: (text) => {
      const trimmed = text.trim();
      // Only URL or URL with minimal noise
      return /^(https?:\/\/[^\s]+)$/.test(trimmed) || /^(LINE|lin\.ee|t\.me)\/[^\s]+$/i.test(trimmed);
    },
  },
  {
    name: "スパム・無言",
    category: "Spam",
    reason: "返信不要と判定: 本文なしまたは無効なメッセージ",
    test: (text) => {
      const trimmed = text.trim();
      return trimmed.length === 0 || /^[\p{Emoji}\s]+$/u.test(trimmed);
    },
  },
  {
    name: "返信不要の明示",
    category: "その他・不明",
    reason: "返信不要と判定: 相手が返信不要を明示している",
    test: (text) => {
      // Only a literal, stand-alone statement ("返信不要です", "リプ不要〜").
      // The trailing boundary prevents false hits like "ご連絡不要な場合は…",
      // and escalation rules for sensitive topics run only after skip rules.
      return /(?:^|[\s。！!\n])(?:返信|ご連絡|リプ)(?:は|が)?不要(?:です|でした)?(?=$|[\s。！!、〜～,])/.test(
        text
      );
    },
  },
];

/**
 * Runs machine rules on the latest counterpart message.
 * `context.hasPriorOutgoing` (boolean) enables the cold-inbound skip rules;
 * when it is not provided those rules stay off.
 * Returns match object or null.
 */
export function evaluateMachineRules(lastMessageText, context = {}) {
  if (!lastMessageText) {
    return {
      action: "skip",
      category: "Spam",
      reason: "本文が空のため返信不要と判定",
      decided_by: "rule",
      rule_hit: "スパム・無言",
    };
  }

  // 1. Check Skip Rules first
  for (const rule of SKIP_RULES) {
    if (rule.test(lastMessageText, context)) {
      return {
        action: "skip",
        category: rule.category,
        reason: rule.reason,
        decided_by: "rule",
        rule_hit: rule.name,
      };
    }
  }

  // 2. Check Escalation Rules
  for (const rule of ESCALATION_RULES) {
    if (rule.test(lastMessageText)) {
      return {
        action: "escalate",
        category: rule.category,
        reason: rule.reason,
        decided_by: "rule",
        rule_hit: rule.name,
      };
    }
  }

  return null;
}

/**
 * Content Gate (文面ゲート)
 * Verifies that the AI-generated draft does NOT make unauthorized promises,
 * mention unapproved dates, prices, deliverables, or unvetted URLs.
 */
export function evaluateContentGate(draftText, _context = {}) {
  if (!draftText || !draftText.trim()) {
    return {
      passed: false,
      gate: "要確認: 下書き本文が空です",
      reason: "下書き本文が生成されていません。",
    };
  }

  const issues = [];

  // Check 1: Deliverable promise ("いつ何を作るか勝手に約束")
  // Match both direct promises ("初稿をお送りします") and nested deliverables
  // ("LPの初稿をお送りします"). Keep the verb list explicit to avoid blocking
  // harmless mentions such as "LPについて相談したいです".
  if (/(?:初稿|デザイン案|仕様書|コード|成果物|納品物|納品|LP|サイト)(?:の)?(?:初稿|デザイン案)?を(?:作成|用意|お送り|提出|お届け|作り|納品|実装|開発)/.test(draftText)) {
    issues.push("成果物の提出・作成を勝手に約束している恐れがあります");
  }

  // Check 2: Unapproved scheduling/dates. Do not use word boundaries around
  // Japanese date units: JavaScript's \\b is ASCII-oriented and can miss them.
  // Durations ("2時間", "24時間") are not time commitments.
  if (/(?:^|[^0-9])\d{1,2}[/／]\d{1,2}(?:日)?|\d{1,2}月\d{1,2}日|\d{1,2}[:：]\d{2}|\d{1,2}時(?!間)/.test(draftText)) {
    issues.push("具体的な日時・時刻の提示が含まれています");
  }

  // Check 3: Pricing or financial amounts. A metric unit (e.g. 5万再生)
  // is not a price; monetary units and pricing language remain blocked.
  const metricAmountContext = /(?:再生|フォロワ|ダウンロード|DL|登録者|ユーザー|PV|閲覧|表示回数|インプレッション|クリック|いいね)/i;
  const explicitMoneyLanguage = /(料金|報酬|金額|見積もり|費用)/;
  const amountPattern = /\d+(?:\.\d+)?万(?:円)?|￥\s?[\d,]+|\$\s?[\d,]+|[\d,]+\s?円/g;
  let amountMatch;
  let hasUnapprovedMoneyAmount = false;
  while ((amountMatch = amountPattern.exec(draftText)) !== null) {
    const nearby = draftText.slice(Math.max(0, amountMatch.index - 20), amountMatch.index + amountMatch[0].length + 12);
    const hasExplicitCurrency = /円|￥|\$/.test(amountMatch[0]);
    const isMetricMention = metricAmountContext.test(nearby) && !explicitMoneyLanguage.test(nearby);
    if (hasExplicitCurrency || !isMetricMention) {
      hasUnapprovedMoneyAmount = true;
      break;
    }
  }
  if (hasUnapprovedMoneyAmount || explicitMoneyLanguage.test(draftText)) {
    issues.push("金額・報酬の言及が含まれています");
  }

  // Check 4: Unverified external URLs
  if (/https?:\/\/[^\s]+/.test(draftText)) {
    issues.push("外部URLリンクが含まれています（要リンク許可確認）");
  }

  if (issues.length > 0) {
    return {
      passed: false,
      gate: `要確認: ${issues.join(" / ")}`,
      reason: issues.join(" / "),
    };
  }

  return {
    passed: true,
    gate: "合格",
    reason: "文面ゲート基準（成果物約束なし・日程なし・金額なし・URLなし）をクリア",
  };
}

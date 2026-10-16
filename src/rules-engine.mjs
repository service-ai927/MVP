/**
 * Machine Rules Engine & Safety Content Gate
 * Grounded in the client's criteria and real-world 21-day benchmark.
 */

// Machine escalation rules (例外なく本人判断)
export const ESCALATION_RULES = [
  {
    name: "日程・MTGの日時",
    category: "日程・MTGの日時",
    reason: "機械ルール: 日程・MTGの日時（例外なく本人判断）",
    test: (text) => {
      // Dates, schedules, calendar invites, meeting proposals
      return (
        /\b\d{1,2}[/／]\d{1,2}\b/.test(text) ||
        /\b\d{1,2}月\d{1,2}日/.test(text) ||
        /\b(月|火|水|木|金|土|日)曜?日?/.test(text) && /\d{1,2}[:：時]/.test(text) ||
        /(日程|打[ち]?合[わ]?せ|ミーティング|MTG|ご都合|面談|zoom|google\s?meet|カレンダー|空き時間|リスケ)/i.test(text)
      );
    },
  },
  {
    name: "金額・条件・契約",
    category: "金額・条件・契約",
    reason: "機械ルール: 金額・条件・契約（例外なく本人判断）",
    test: (text) => {
      // Pricing, compensation, contractual terms
      return /(単価|見積|請求|予算|費用|料金|金額|\d+万(円)?|成果報酬|固定額|成約|手数料|契約|発注|受託)/i.test(
        text
      );
    },
  },
  {
    name: "実績の数字を聞かれている",
    category: "実績の数字を聞かれている",
    reason: "機械ルール: 実績の数字（DL数・売上等）は機械が答えない",
    test: (text) => {
      return /(ダウンロード|DL数|売上|月商|年商|PV数|ユーザー数|登録者数|実績の数字)/i.test(
        text
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

// Machine skip rules (返信不要と判定)
export const SKIP_RULES = [
  {
    name: "業者の一斉営業",
    category: "業者の一斉営業",
    reason: "返信不要と判定: 一斉配信の定型（罫線・▼・キャンペーン等）",
    test: (text) => {
      return (
        /━{4,}|─{4,}|＝{4,}/.test(text) ||
        /(【期間限定|特別キャンペーン|初月無料|SNS運用代行|集客自動化|▼登録はこちら|▼詳細はこちら)/i.test(text)
      );
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
];

/**
 * Runs machine rules on the latest counterpart message.
 * Returns match object or null.
 */
export function evaluateMachineRules(lastMessageText) {
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
    if (rule.test(lastMessageText)) {
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
  if (/(初稿|デザイン案|仕様書|コード|成果物|納品|LP|サイト)を(作成|用意|お送り|提出|お届け|作り)/.test(draftText)) {
    issues.push("成果物の提出・作成を勝手に約束している恐れがあります");
  }

  // Check 2: Unapproved scheduling/dates
  if (/\b\d{1,2}[/／]\d{1,2}\b|\b\d{1,2}月\d{1,2}日|\d{1,2}[:：時]/.test(draftText)) {
    issues.push("具体的な日時・時刻の提示が含まれています");
  }

  // Check 3: Pricing or financial amounts
  if (/\d+万(円)?|￥\d+|\$\d+|見積もり額|費用として/.test(draftText)) {
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

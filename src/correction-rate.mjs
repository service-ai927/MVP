/**
 * Human classification correction tracking.
 *
 * The AI assigns a classification (machine rules or Gemini) and the operator may
 * override it afterwards. To measure how often the AI needs a human correction,
 * the first AI-assigned classification is snapshotted into `original_classification`
 * and is never overwritten by later human edits or re-triage.
 *
 * Correction Rate = (corrected eligible items / eligible human-reviewed items) * 100
 *
 * Eligible items have an available original AI classification AND completed human
 * review (`human_reviewed_at`). Records without an original classification are
 * excluded entirely: for older records the original value may simply be unknown,
 * and they must not be counted as uncorrected items.
 *
 * Audit trail: how review was evidenced is recorded in `human_reviewed_via`
 * ("update_classification" = the operator explicitly saved the classification
 * panel; "approve"/"complete" = the item was completed, which evidences review
 * of the whole item including its classification; records created before this
 * field existed carry no value). `computeCorrectionRate` keeps the headline
 * definition unchanged and additionally reports the `reviewEvidence` split so
 * the denominator can be audited.
 */

const AI_DECIDED_BY = new Set(["rule", "llm", "fallback"]);
const SOURCES = ["llm", "rule", "fallback"];
const REVIEW_EVIDENCE = {
  CLASSIFICATION_UPDATE: "update_classification",
};
const REVIEW_EVIDENCE_BUCKETS = ["classificationUpdate", "completion", "unspecified"];

function clone(value) {
  return value === undefined || value === null ? value : structuredClone(value);
}

function normalized(value) {
  return String(value ?? "").trim();
}

/** Which review-evidence bucket an item belongs to (audit split only). */
function reviewEvidenceBucket(item) {
  const via = normalized(item?.human_reviewed_via);
  if (via === REVIEW_EVIDENCE.CLASSIFICATION_UPDATE) return "classificationUpdate";
  return via ? "completion" : "unspecified";
}

/** True when a preserved original AI classification is available for this item. */
export function hasOriginalClassification(item) {
  const original = item?.original_classification;
  return Boolean(original && normalized(original.action));
}

/** True when the item completed human review (`human_reviewed_at` is recorded). */
export function isHumanReviewed(item) {
  return Boolean(normalized(item?.human_reviewed_at));
}

/**
 * Snapshot the current classification into `original_classification`, but only the
 * first time and only when the classification was produced by the AI pipeline
 * (`decided_by` of "rule" or "llm"). Existing snapshots are never overwritten, so
 * re-triage and human edits cannot destroy the original value. Records whose
 * classification was made by a human (or another non-AI source) keep no original
 * classification, because the AI value is unknown for them.
 */
export function ensureOriginalClassification(item) {
  if (!item || hasOriginalClassification(item)) return item;
  if (!AI_DECIDED_BY.has(item.classification?.decided_by)) return item;
  item.original_classification = clone(item.classification);
  return item;
}

/**
 * Mark the item as having completed human review. Idempotent: the first
 * completion timestamp wins, so repeated actions never reset review state.
 *
 * `via` records which action evidenced the review ("update_classification",
 * "approve", "complete") for the audit split. The evidence source only
 * upgrades: an explicit classification review replaces completion evidence,
 * never the other way around. Records without `via` stay in the "unspecified"
 * bucket (backward compatible with data saved before this field existed).
 */
export function markHumanReviewed(item, via) {
  if (!item) return item;
  const source = normalized(via);
  if (!isHumanReviewed(item)) {
    item.human_reviewed_at = new Date().toISOString();
  }
  if (source) {
    const current = normalized(item.human_reviewed_via);
    if (
      !current ||
      (source === REVIEW_EVIDENCE.CLASSIFICATION_UPDATE &&
        current !== REVIEW_EVIDENCE.CLASSIFICATION_UPDATE)
    ) {
      item.human_reviewed_via = source;
    }
  }
  return item;
}

/**
 * Apply a human classification edit. The preserved original AI classification is
 * left untouched and the item is marked human-reviewed. Repeated edits only update
 * the current classification, and corrections are derived from the final value, so
 * multiple edits can never inflate the correction count.
 *
 * The caller is responsible for validating `payload.action`.
 */
export function applyHumanClassification(item, payload = {}) {
  if (!item) return item;
  item.classification = {
    ...item.classification,
    action: payload.action,
    category: normalized(payload.category),
    reason: normalized(payload.reason),
    decided_by: "human",
    rule_hit: null,
  };
  return markHumanReviewed(item, REVIEW_EVIDENCE.CLASSIFICATION_UPDATE);
}

/**
 * Prepare an incoming (imported) thread. Keeps an original snapshot and review
 * flag already stored for the same thread id, otherwise derives the original from
 * the current classification when it is still marked as AI-decided. Never invents
 * an original classification for records where it is unavailable.
 */
export function prepareImportedThread(incoming, existing) {
  const merged = structuredClone(incoming);
  if (!hasOriginalClassification(merged) && hasOriginalClassification(existing)) {
    merged.original_classification = clone(existing.original_classification);
  }
  if (!isHumanReviewed(merged) && isHumanReviewed(existing)) {
    merged.human_reviewed_at = existing.human_reviewed_at;
    if (normalized(existing.human_reviewed_via)) {
      merged.human_reviewed_via = existing.human_reviewed_via;
    }
  }
  return ensureOriginalClassification(merged);
}

/**
 * True when the final action (自動 / 要確認 / 返信不要) differs from the
 * preserved original AI action. This matches the client's definition of
 * 分類を直した割合: their 10/15-21 report counted action changes only
 * (要確認→返信不要 32, 自動→返信不要 7, ...). Category labels are free text
 * (Gemini invents its own), so a relabel alone is reported separately as
 * `categoryOnlyChanges` and never counted as a correction.
 * Always false when the original is unavailable or the final value is missing.
 */
export function isCorrectedClassification(item) {
  if (!hasOriginalClassification(item)) return false;
  const current = item?.classification;
  if (!normalized(current?.action)) return false;
  return normalized(item.original_classification.action) !== normalized(current.action);
}

/** Same action, different category label. Informational only. */
export function isCategoryOnlyChange(item) {
  if (!hasOriginalClassification(item) || isCorrectedClassification(item)) return false;
  const current = item?.classification;
  if (!normalized(current?.action)) return false;
  return normalized(item.original_classification.category) !== normalized(current?.category);
}

/** Which pipeline stage produced the original classification. */
export function originalSource(item) {
  const by = normalized(item?.original_classification?.decided_by);
  return SOURCES.includes(by) ? by : "unknown";
}

/**
 * Breakdown in the same shape as the client's report: correction rate per
 * original source (Gemini / 機械ルール / テンプレート) and the count of each
 * "original→final" action transition, over the same eligible items as
 * computeCorrectionRate. Pass `isEligible` to scope it (e.g. to a window).
 */
export function computeCorrectionBreakdown(items, isEligible = isHumanReviewed) {
  const bySource = Object.fromEntries(
    [...SOURCES, "unknown"].map((source) => [source, { eligibleItems: 0, correctedItems: 0, ratePercent: null }])
  );
  const transitions = {};
  let categoryOnlyChanges = 0;

  for (const item of Array.isArray(items) ? items : []) {
    if (!hasOriginalClassification(item) || !isEligible(item)) continue;
    if (!normalized(item?.classification?.action)) continue;
    const bucket = bySource[originalSource(item)];
    bucket.eligibleItems += 1;
    if (isCorrectedClassification(item)) {
      bucket.correctedItems += 1;
      const key = `${normalized(item.original_classification.action)}→${normalized(item.classification.action)}`;
      transitions[key] = (transitions[key] || 0) + 1;
    } else if (isCategoryOnlyChange(item)) {
      categoryOnlyChanges += 1;
    }
  }
  for (const bucket of Object.values(bySource)) {
    bucket.ratePercent =
      bucket.eligibleItems > 0 ? Math.round((bucket.correctedItems / bucket.eligibleItems) * 1000) / 10 : null;
  }
  return { bySource, transitions, categoryOnlyChanges };
}

/**
 * Correction rate over eligible items: original AI classification available and
 * human review completed. Items without an original classification are skipped, so
 * they never count as uncorrected. Returns `ratePercent: null` when there is
 * nothing to measure, so callers never display NaN or Infinity.
 *
 * The headline numbers keep the original definition. `reviewEvidence` splits the
 * same eligible items by how review was evidenced (classificationUpdate /
 * completion / unspecified; the three always sum to the headline totals) so the
 * denominator can be audited — e.g. the strict "classification was explicitly
 * reviewed" subset is `classificationUpdate`.
 */
export function computeCorrectionRate(items) {
  let eligibleReviewedItems = 0;
  let correctedItems = 0;
  const reviewEvidence = Object.fromEntries(
    REVIEW_EVIDENCE_BUCKETS.map((bucket) => [bucket, { eligibleItems: 0, correctedItems: 0 }])
  );

  for (const item of Array.isArray(items) ? items : []) {
    if (!hasOriginalClassification(item) || !isHumanReviewed(item)) continue;
    if (!normalized(item?.classification?.action)) continue;
    eligibleReviewedItems += 1;
    const bucket = reviewEvidence[reviewEvidenceBucket(item)];
    bucket.eligibleItems += 1;
    if (isCorrectedClassification(item)) {
      correctedItems += 1;
      bucket.correctedItems += 1;
    }
  }

  const ratePercent =
    eligibleReviewedItems > 0
      ? Math.round((correctedItems / eligibleReviewedItems) * 1000) / 10
      : null;

  return { eligibleReviewedItems, correctedItems, ratePercent, reviewEvidence };
}

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
 */

const AI_DECIDED_BY = new Set(["rule", "llm"]);

function clone(value) {
  return value === undefined || value === null ? value : structuredClone(value);
}

function normalized(value) {
  return String(value ?? "").trim();
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
 */
export function markHumanReviewed(item) {
  if (!item || isHumanReviewed(item)) return item;
  item.human_reviewed_at = new Date().toISOString();
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
  return markHumanReviewed(item);
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
  }
  return ensureOriginalClassification(merged);
}

/**
 * True when the final classification differs from the preserved original AI
 * classification (action or category; reasons are free text and ignored).
 * Always false when the original is unavailable or the final value is missing.
 */
export function isCorrectedClassification(item) {
  if (!hasOriginalClassification(item)) return false;
  const current = item?.classification;
  if (!normalized(current?.action)) return false;
  const original = item.original_classification;
  return (
    normalized(original.action) !== normalized(current.action) ||
    normalized(original.category) !== normalized(current.category)
  );
}

/**
 * Correction rate over eligible items: original AI classification available and
 * human review completed. Items without an original classification are skipped, so
 * they never count as uncorrected. Returns `ratePercent: null` when there is
 * nothing to measure, so callers never display NaN or Infinity.
 */
export function computeCorrectionRate(items) {
  let eligibleReviewedItems = 0;
  let correctedItems = 0;

  for (const item of Array.isArray(items) ? items : []) {
    if (!hasOriginalClassification(item) || !isHumanReviewed(item)) continue;
    if (!normalized(item?.classification?.action)) continue;
    eligibleReviewedItems += 1;
    if (isCorrectedClassification(item)) correctedItems += 1;
  }

  const ratePercent =
    eligibleReviewedItems > 0
      ? Math.round((correctedItems / eligibleReviewedItems) * 1000) / 10
      : null;

  return { eligibleReviewedItems, correctedItems, ratePercent };
}

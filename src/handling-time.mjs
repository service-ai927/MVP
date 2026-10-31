/**
 * Handling-time summary: manual baseline vs MVP-assisted handling.
 *
 * The client asked to time the first 10 items handled by hand as a comparison
 * baseline. The app records each stopwatch entry in `handling_time_records`
 * as { seconds, mode: "manual" | "mvp", at }. Times are summed per thread and
 * mode, so one item handled in several steps counts once.
 *
 * Threads saved before records existed carry only `handling_time_seconds`;
 * they count as MVP-assisted, and only when no window is given (they have no
 * timestamp, so they can never be placed inside an evaluation window).
 */

export const MANUAL_BASELINE_SAMPLE_SIZE = 10;

function stats(values) {
  if (values.length === 0) return { meanSeconds: null, medianSeconds: null };
  const sorted = [...values].sort((a, b) => a - b);
  const m = Math.floor(sorted.length / 2);
  return {
    meanSeconds: Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10,
    medianSeconds: sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2,
  };
}

function inWindow(at, window) {
  if (!window) return true;
  const time = new Date(at).getTime();
  return Number.isFinite(time) && time >= window.start.getTime() && time < window.end.getTime();
}

/**
 * @param {Array} threads
 * @param {{ start: Date, end: Date }} [window] optional, end-exclusive
 */
export function summarizeHandlingTimes(threads, window) {
  const perMode = { manual: [], mvp: [] };

  for (const thread of Array.isArray(threads) ? threads : []) {
    const records = Array.isArray(thread?.handling_time_records) ? thread.handling_time_records : [];
    if (records.length === 0) {
      const legacy = Number(thread?.handling_time_seconds);
      if (!window && Number.isFinite(legacy) && legacy > 0) perMode.mvp.push({ seconds: legacy, firstAt: "" });
      continue;
    }
    for (const mode of ["manual", "mvp"]) {
      const matching = records.filter(
        (r) => r?.mode === mode && Number.isFinite(r?.seconds) && r.seconds > 0 && inWindow(r.at, window)
      );
      if (matching.length === 0) continue;
      perMode[mode].push({
        seconds: matching.reduce((sum, r) => sum + r.seconds, 0),
        firstAt: matching.map((r) => String(r.at || "")).sort()[0],
      });
    }
  }

  // First 10 manually handled items, in the order they were handled.
  const manualFirst = perMode.manual
    .sort((a, b) => a.firstAt.localeCompare(b.firstAt))
    .slice(0, MANUAL_BASELINE_SAMPLE_SIZE)
    .map((item) => item.seconds);
  const mvpValues = perMode.mvp.map((item) => item.seconds);

  const manual = { items: manualFirst.length, seconds: manualFirst, ...stats(manualFirst) };
  const mvp = { items: mvpValues.length, ...stats(mvpValues) };
  const reductionPercent =
    manual.meanSeconds && mvp.meanSeconds != null
      ? Math.round(((manual.meanSeconds - mvp.meanSeconds) / manual.meanSeconds) * 1000) / 10
      : null;

  return {
    manualBaseline: {
      ...manual,
      targetSampleSize: MANUAL_BASELINE_SAMPLE_SIZE,
      sampleComplete: manual.items >= MANUAL_BASELINE_SAMPLE_SIZE,
    },
    mvpAssisted: mvp,
    reductionPercent,
  };
}

# One-week evaluation runbook

This procedure is read-only with respect to the repository and uses JSON exports. Do not reset sample data, re-import exports, or modify `.data/threads.json` for evaluation. The server also enforces this: `POST /api/reset-samples` is refused unless the server was deliberately started with `ALLOW_SAMPLE_RESET=true` (disposable instances only).

## Before the window starts

1. Have the PR reviewed and merged through the normal review process; verify the intended commit is actually running in the environment being evaluated.
2. Confirm `GET /api/health` reports `ok: true`. Check `hasGeminiKey` without exposing the key. A configured key alone does not prove Gemini calls succeeded; verify the draft source on a small, approved test conversation using non-sensitive synthetic text first.
3. Record the start time in ISO 8601 with timezone, the running Git SHA, operator, and environment. Do not put credentials in the log.
4. Save a restricted-access JSON export from `GET /api/export` as the start snapshot. The export contains sensitive conversation data; do not commit or email it.

## During the seven-day window

- Process messages normally; keep human approval mandatory.
- For every evaluated draft, rate it in the app: `helpful` (usable as-is), `minor_edit` (usable after small edits), or `poor` (complete rewrite/unusable). The app records `quality_rated_at` when a rating is saved, and the report uses that timestamp to include ratings from this window. Avoid leaving ratings blank. Rate after the final regeneration: regenerating a draft clears the previous rating, because a rating must describe the draft text it judged.
- For the first 10 items, press **手作業で計測** before reading the item. The AI classification, draft, and inbox hints are hidden; decide and write the reply yourself, then press **計測を終了して記録**. Each time is stored with `mode: "manual"` and its own timestamp. Normal handling is timed automatically (`mode: "mvp"`). A separate operator log is optional (see `--handling-log`).
- Do not bulk re-triage reviewed threads, re-import old exports, or reset demo data.

## At the end

1. Record end timestamp (exclusive), timezone, and running SHA.
2. Save a restricted-access JSON export from `GET /api/export`.
3. Run the read-only report script against the end export:

```bash
node scripts/evaluate-week.mjs --input /secure/path/outreach-threads-end.json --start 2026-10-28T00:00:00+05:30 --end 2026-11-04T00:00:00+05:30 > /secure/path/evaluation-report.json
```

Use the actual recorded start/end timestamps, not the example dates. `--start` and `--end` must include an explicit timezone offset (`Z` or `±HH:MM`); timezone-less values are rejected rather than silently interpreted. The client-agreed thresholds are the defaults; if the agreed values change, pass `--target-correction-max <0-100>` and `--target-usability-min <0-100>` instead of editing the script. Keep exports and report in an access-controlled local folder.

## Metric definitions and cautions

- Headline correction rate: among items whose `human_reviewed_at` falls inside the window and that have both an original AI action and a current action, count items whose final action (auto / escalate / skip) differs from `original_classification` — the same definition as the client's report. Category-only relabels are reported separately (`breakdown.categoryOnlyChanges`). Target ≤15%. `breakdown.bySource` splits the rate by original source (Gemini / 機械ルール / テンプレート) and `breakdown.transitions` counts e.g. `escalate→skip` (要確認→返信不要).
- Strict correction rate: same comparison, but only where `human_reviewed_via === "update_classification"` and current `classification.decided_by === "human"`. This avoids treating approvals/completions as proof that classification was explicitly inspected. Show both rates and denominators.
- Draft usability: ratings whose `quality_rated_at` falls inside the window; `(helpful + minor_edit) / all rated drafts × 100`. Target ≥70%. This differs from the stricter “usable as-is” rate, which is `helpful / all rated drafts`.
- Handling time: `handlingTime` is the manual baseline — the first 10 in-app manual records inside the window (or the operator log when `--handling-log` is given). `mvpAssistedHandlingTime` covers MVP-mode records in the window and reports the reduction against the baseline only once the 10-item baseline is complete. Older items that only carry `handling_time_seconds` have no timestamp and are excluded from the window.
- The script cannot establish whether Gemini actually generated each draft. Validate generator/source separately and note fallback drafts in the report.
- If a denominator is zero, report N/A, not 0%. If fewer than 10 eligible reviewed items exist, mark the correction rate as indicative.
- The script deduplicates repeated thread IDs (first occurrence wins, reported in `dataQuality`) and excludes rated items that carry no `quality_rated_at` (rated before the timestamp existed) from every window; both are surfaced as data-quality warnings, so check `dataQuality` before quoting any number.
- Never include raw messages, contact names, handles, or thread IDs in a client-facing summary.

## Client report template

- Evaluation period / timezone:
- Running commit SHA:
- Operator:
- Number of eligible reviewed classifications:
- Headline correction rate: corrected / eligible = __% (target ≤15%)
- Strict correction rate: corrected / explicitly reviewed eligible = __%
- Draft ratings: helpful __, minor edit __, poor __; usability = (helpful + minor edit) / all rated = __% (target ≥70%)
- First 10 handling times (seconds): __; median __; mean __
- Gemini vs template fallback notes:
- Data-quality warnings / sample-size limitations:
- Conclusion: target met / not met / insufficient data for each metric.

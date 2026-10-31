# Seven-Day Evaluation — Daily Tracking Log

One row per day. Numbers come from `GET /api/metrics` (same-origin, loopback) and
your own worksheets — never from memory, never estimated. If a day had no activity,
write `0` for counts and `–` for time entries.

| Day | Date | Items handled | Classification corrections made | Drafts rated (as-is / minor / rewrite) | Handling times recorded (first 10) | Notes (no client content) |
| --- | --- | --- | --- | --- | --- | --- |
| 1 |  |  |  |  /  /  |  |  |
| 2 |  |  |  |  /  /  |  |  |
| 3 |  |  |  |  /  /  |  |  |
| 4 |  |  |  |  /  /  |  |  |
| 5 |  |  |  |  /  /  |  |  |
| 6 |  |  |  |  /  /  |  |  |
| 7 |  |  |  |  /  /  |  |  |

How to get each column:

- **Items handled** — count of conversations you completed that day (the app's
  完了 status count increases).
- **Corrections** — every time you press 分類を修正 and save; the app records
  `human_reviewed_at` + `human_reviewed_via` automatically.
- **Drafts rated** — every 良好 / 編集あり / 要修正 press; the app timestamps each
  rating (`quality_rated_at`). Rate after final regeneration.
- **Handling times** — entries made in [handling-time-worksheet.md](./handling-time-worksheet.md) (first 10 only).

Final report (day 7, after recording the end timestamp):

```bash
node scripts/evaluation-start.mjs --help   # see how the start record was captured
node scripts/evaluate-week.mjs --input <end-export.json> --start <evaluationStart from evaluation-start.json> --end <day-7 timestamp with tz> --handling-log <handling-log.json>
```

The report classifies each metric as **target achieved**, **target not achieved**, or
**insufficient data** (zero denominators and <10 timing entries are reported as
insufficient, never as 0%). See [one-week-evaluation-runbook.md](./one-week-evaluation-runbook.md)
for the client report template.

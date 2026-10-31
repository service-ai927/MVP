# First-10 Handling-Time Worksheet (optional)

The app is the system of record: **手作業で計測** hides the AI result, times the item,
and stores it as a manual baseline record with its own timestamp. This worksheet is an
optional paper backup for the same first 10 items, for operators who also want an
explicit sequence number and notes. If you pass it to the report with
`--handling-log`, it takes precedence over the in-app manual records.

Rules:
- Fill one numbered row per item, **at the moment you handle it** (contemporaneous).
- Do **not** write message text, contact names, or handles here — thread ID only.
- Never backfill or estimate. If you forgot to start the stopwatch, write
  `not recorded` for that row; do not infer a duration.

| # | Thread ID | Start (ISO, with tz) | End (ISO, with tz) | Duration (s) | In-app recorded? | Notes (no client content) |
| --- | --- | --- | --- | --- | --- | --- |
| 1 |  |  |  |  | ☐ yes ☐ not recorded |  |
| 2 |  |  |  |  | ☐ yes ☐ not recorded |  |
| 3 |  |  |  |  | ☐ yes ☐ not recorded |  |
| 4 |  |  |  |  | ☐ yes ☐ not recorded |  |
| 5 |  |  |  |  | ☐ yes ☐ not recorded |  |
| 6 |  |  |  |  | ☐ yes ☐ not recorded |  |
| 7 |  |  |  |  | ☐ yes ☐ not recorded |  |
| 8 |  |  |  |  | ☐ yes ☐ not recorded |  |
| 9 |  |  |  |  | ☐ yes ☐ not recorded |  |
| 10 |  |  |  |  | ☐ yes ☐ not recorded |  |

At the end of the window, save the first 10 durations as JSON and pass them to the
report script with `--handling-log` — the script never infers timings from the export,
it only transcribes what you recorded here:

```json
[
  { "entry": 1, "seconds": 184 },
  { "entry": 2, "seconds": 220 }
]
```

```bash
node scripts/evaluate-week.mjs --input <export.json> --start <...> --end <...> --handling-log <handling-log.json>
```

Fewer than 10 entries are reported as "Insufficient data", not estimated. Keep this
worksheet in the same access-controlled folder as the exports.

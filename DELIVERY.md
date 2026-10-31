# Outreach Pipeline MVP — Client Delivery Guide

Repository baseline at this delivery update: `69aa879060a2f8f1e29453909e27ba2ef8c8da07` (branch `main`; verify the deployed SHA separately before a live evaluation).
Date: 2026-10-30. Local verification environment: Windows 11, Node 24, Chrome.

## 1. How to start the app (Windows)

```powershell
cd C:\Users\USER\Desktop\outreach-pipeline-mvp
npm install        # first time only
npm start          # production mode, serves the built UI from dist/
```

For development with hot reload use `npm run dev` instead (same port, no build needed).
`npm run build` must be run at least once before `npm start` if `dist/` is missing.

## 2. Local app URL

- App: http://127.0.0.1:3000
- Health check (no auth needed, loopback only): http://127.0.0.1:3000/api/health

The server binds to loopback (`127.0.0.1`) by default, so only this machine can reach it.

## 3. Required environment variables

None are required for local use — the app runs fully with defaults.

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `GEMINI_API_KEY` | No | unset | Enables live AI classification and draft generation (see §4) |
| `PORT` | No | `3000` | HTTP port |
| `HOST` | No | `127.0.0.1` | Bind address. Non-loopback in production requires `API_AUTH_TOKEN` |
| `NODE_ENV` | No | unset | `production` serves the built `dist/` bundle |
| `API_AUTH_TOKEN` | No | unset | Bearer token required for non-loopback API access |
| `ALLOWED_ORIGINS` | No | unset | Comma-separated origins granted CORS. None get CORS by default |
| `RATE_LIMIT_PER_MINUTE` | No | `300` | Per-address API request budget |
| `MAX_THREADS` | No | `5000` | Cap on stored conversations |
| `ALLOW_SAMPLE_RESET` | No | unset | Must be `true` to enable the destructive reset endpoint |
| `DATA_DIR` | No | `.data` | Where `threads.json` is persisted |

## 4. How to configure Gemini securely

Set the key in the server's environment **before** starting; it is read from the process
environment only (no `.env` loader — do not place keys in tracked files):

```powershell
# PowerShell (per session)
$env:GEMINI_API_KEY = "YOUR_GEMINI_API_KEY"
npm start
```

```bash
# bash / zsh
export GEMINI_API_KEY="YOUR_GEMINI_API_KEY"
npm start
```

Rules:
- Never paste the key into chat, issues, screenshots, or Git.
- Confirm the key loaded: `http://127.0.0.1:3000/api/health` must show `"hasGeminiKey": true`.
- The key is never returned by any endpoint. Keep it only in the server process environment or hosting secret store; never commit it.

## 5. Supported workflows

1. **Receive / add** a conversation (inbox, or the 受信メッセージを追加 button).
2. **Classify** — built-in rules always run; with a Gemini key the LLM also decides.
   Scheduling, pricing/contract, performance-metric asks, complaints, and acquaintance
   contact are always routed to human review (確認が必要).
3. **Generate a draft** — AI draft with content-safety gate; gate failures are withheld
   and escalated for review.
4. **Review and approve** — edit, rate (良好 / 編集あり / 要修正), return for revision, hold,
   or approve and complete (承認して対応完了にする).
5. **Bulk triage** (すべてを振り分け) never overwrites a human-saved classification.
6. **Export** JSON / CSV for backup and evaluation; **import** JSON to load conversations.
7. **Metrics dashboard** (検証・計測) shows the agreed targets, the correction rate by
   source (Gemini / 機械ルール / テンプレート), the correction transitions, draft ratings,
   and manual-baseline vs MVP handling time.

## 6. Human review and approval

- Approval is **always manual**. There is no auto-send and no connection to X, LinkedIn,
  or any email provider: approving a draft only marks the conversation complete in this app.
- Approving requires a non-empty draft.
- Regenerating a draft clears its previous quality rating (the rating must describe the
  current text).
- Draft quality ratings and optional handling-time entries (`record_time`) feed the
  evaluation script.

## 7. Template fallback during Gemini outages

Transient Gemini errors (429/5xx/timeouts) are retried with backoff first
(`GEMINI_MAX_RETRIES`, default 2). If the key is missing, invalid, or the retries are
exhausted, the server **falls back to a labelled template draft** instead of failing.
Template decisions are recorded as `decided_by: "fallback"`, so they are reported
separately from machine rules and Gemini:
- Check the draft source: `template_fallback` = template, `gemini` = real AI output.
- The UI and API never present a template as Gemini output.
- Provider errors are logged server-side only; API responses stay generic.
- A draft appearing is **not** proof the model ran — always check the source label.

## 8. Known limitations

- Local JSON file storage (`threads.json`), no automatic backups — copying the data
  directory is the backup mechanism. Do not run on hosts with ephemeral disks.
- No user accounts: anyone who can reach the API sees all conversations. Keep loopback
  or put an authenticated reverse proxy in front.
- No external message delivery by design.
- Gemini free tier is shared capacity: drafts may be slow or temporarily fall back to
  templates during demand spikes (verified: Google 503s observed, fallback engaged).
- Live evaluation metrics (correction rate, usability, handling time) are **unmeasured**
  until a real operator week is completed; sample size is currently zero.

## 9. Deployment requirements

- Node.js 22+ on the host; `npm install`, `npm run build`, `npm start`.
- Set `HOST=0.0.0.0` **and** a strong `API_AUTH_TOKEN`, or keep loopback behind a VPN /
  authenticated reverse proxy. Production startup **fails closed** if exposed without a token.
- Set `GEMINI_API_KEY` in the host's secret store (never on disk in the repo).
- Use persistent storage for `DATA_DIR`; take regular copies as backups.
- Do **not** set `ALLOW_SAMPLE_RESET=true` outside disposable test instances.
- Record the exact deployed commit SHA. The repository baseline documented above is not proof that a host is running that commit.

## 10. One-week evaluation instructions

1. Record start date/time with timezone, operator name, deployed commit, and Gemini state.
2. For the first 10 items, press **手作業で計測** before reading the item: the AI result
   is hidden while you decide and write the reply yourself; press **計測を終了して記録**
   when done. This is the manual baseline the client asked for.
3. For each item handled: save your classification correction (if any) via 分類を修正
   and rate every AI draft (そのまま使える / 軽い修正で使える / 書き直しが必要).
   MVP handling time is recorded automatically on each workflow action.
4. At the end of the week: export JSON from the UI (or `GET /api/export`) and run:

```bash
node scripts/evaluate-week.mjs --input <export.json> --start 2026-11-06T09:00:00+09:00 --end 2026-11-13T09:00:00+09:00
```

5. Targets: classification correction rate ≤ 15% (action changes, as in the client's
   report), draft usability (helpful + minor_edit) ≥ 70%, manual baseline for the first
   10 items vs MVP-assisted time.
6. Report targets as met / not met / **insufficient data** — never infer results.

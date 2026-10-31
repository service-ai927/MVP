# Outreach Pipeline MVP

AI-assisted outreach reply triage and human-review dashboard. The interface is localized in Japanese.

## Requirements

- Node.js 22 or newer (built and tested on Node 24)
- npm
- Optional: a local Chrome or Chromium install, for the real-browser test suites
- Optional: a Google Gemini API key for live AI classification and draft generation

## Environment variables

The server reads these from the **process environment**. It has no dotenv loader, so a `.env` file is *not* read automatically — set them in your shell, in your service manager, or in your hosting platform's config UI.

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `GEMINI_API_KEY` | No | unset | Enables live Gemini classification and draft generation. See below. |
| `PORT` | No | `3000` | HTTP port for the API and UI. `0` picks a free port (used by tests). |
| `HOST` | No | `127.0.0.1` | Bind address. Loopback by default; see "Security and deployment" before exposing it. |
| `NODE_ENV` | No | unset | `production` serves the built `dist/` bundle; anything else runs the Vite dev server. |
| `API_AUTH_TOKEN` | No | unset | Shared bearer token required for non-loopback API access. Mandatory when `HOST` is non-loopback in production. |
| `ALLOWED_ORIGINS` | No | unset | Comma-separated origins allowed CORS access (e.g. `https://app.example.com`). No CORS headers are sent without it. |
| `RATE_LIMIT_PER_MINUTE` | No | `300` | Per-address request budget for `/api/*`. `0` disables rate limiting. |
| `MAX_THREADS` | No | `5000` | Cap on stored/imported conversations. |
| `ALLOW_SAMPLE_RESET` | No | unset | Must be `true` to enable the destructive `POST /api/reset-samples` endpoint. |
| `DATA_DIR` | No | `.data` | Directory for `threads.json` persistence. Tests point this at temp directories. |

`GET /api/health` reports the effective state, including `hasGeminiKey`, so you can confirm the key was picked up without printing it. It is the only unauthenticated API route and returns operational metadata only — never conversation content or secret values.

## Security and deployment

The server is configured fail-closed for network exposure:

- **Bind address.** `HOST` defaults to `127.0.0.1`, so a freshly started server is reachable only from the local machine. In production, binding a non-loopback host **without** `API_AUTH_TOKEN` aborts startup with an explicit error.
- **Authentication.** There is no user-account system in this MVP. `API_AUTH_TOKEN` is a shared bearer token for API clients (`Authorization: Bearer <token>`, checked in constant time). A token presented from anywhere — including loopback — must be valid. Loopback clients (the local operator's browser) work without a token. For remote *browser* access, put an authenticating reverse proxy (or VPN/SSH tunnel) in front and keep the server on loopback; do not expose it raw.
- **CORS.** No wildcard mode exists. Only origins listed in `ALLOWED_ORIGINS` receive CORS headers; without configuration the browser refuses cross-origin reads of API responses. The UI is served same-origin and needs no CORS at all.
- **Headers and limits.** Every response carries `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, and `Cross-Origin-Opener-Policy: same-origin`; production responses additionally carry a `Content-Security-Policy` (external scripts only; inline styles allowed for the React UI). `/api/*` has a per-address rate limit, request bodies are capped at 5 MB, individual text fields are length-capped, and thread counts are capped by `MAX_THREADS`.
- **Input validation.** Import payloads are sanitized (prototype-pollution keys stripped, structure validated) before touching state; workflow actions validate ratings, tones, and timing values against allowlists/ranges; error responses return JSON with generic messages for 5xx — stack traces, provider errors, and filesystem paths are logged server-side only.
- **Destructive reset.** `POST /api/reset-samples` replaces *every* conversation with the demo set, so it is refused with `403` unless the server was started with `ALLOW_SAMPLE_RESET=true`. Only enable it on disposable instances.
- **Secrets.** `GEMINI_API_KEY` stays server-side; it is never returned by any route (the health endpoint exposes only a boolean). Never commit keys — `.data/` and `.env*` are ignored by Git for this reason.

What this is not: it is not multi-user authentication, authorization, or audit logging. For a hosted multi-operator deployment, add a real identity provider and an access-controlled database first (see "Data persistence").

### Gemini API key

Without a key the app still runs fully: classification uses the built-in rules engine and drafts use a labelled template fallback.

**Real Gemini generation only happens when `GEMINI_API_KEY` is set to a valid key** in the server's environment *before* start. If the key is missing, expired, or invalid, the server silently falls back to templates rather than failing — so a "draft" you see is not proof the model ran. Check `hasGeminiKey` in `/api/health` and the draft's `source` field to tell them apart.

Never commit a key. `.data/` and `.env*` are ignored by Git for this reason.

## Run locally

```bash
npm install
npm run dev
```

Open the local URL printed in the terminal (port 3000 unless `PORT` is set).

To enable Gemini, export the key in the same shell before starting:

```powershell
# PowerShell
$env:GEMINI_API_KEY = "YOUR_GEMINI_API_KEY"
npm run dev
```

```bash
# bash / zsh
export GEMINI_API_KEY="YOUR_GEMINI_API_KEY"
npm run dev
```

Do not commit API keys or real contact/message data.

## Run the built app

```bash
npm run build
npm start
```

`npm start` sets `NODE_ENV=production` and serves the compiled `dist/` bundle. This path is exercised by `npm run test:smoke`. Note that the `NODE_ENV=production` prefix in the `start` script is Unix shell syntax; on Windows run it through a POSIX shell (Git Bash, WSL) or set the variable first.


## Workflow

1. Receive or import a conversation.
2. Classify it with machine rules and, when configured, Gemini.
3. Route scheduling, pricing, contract, complaint, and other sensitive cases to human review.
4. Generate a draft, inspect the content gate, edit if needed, and approve it.
5. Record the result and rate draft quality.

**Approval does not send an external message.** This MVP has no connection to X, LinkedIn, email, or another delivery provider. Approving a draft only marks the conversation complete inside this app.

If Gemini is unavailable, the app may provide a template fallback. The UI identifies this as a template rather than claiming it was generated by Gemini. Drafts that fail the content safety gate are withheld from the generated-draft field and routed for review.

Classification behaviour notes:

- Scheduling (dates, clock times, meeting keywords), pricing/contract keywords, questions asking for our performance numbers, complaints/declines, and acquaintance contact are always routed to human review. Metric-context numbers ("フォロワー数は3万") and growth/how-to questions ("登録者数を増やしたいんです") are *not* treated as money or metrics asks, so they can be answered automatically.
- Messages where the counterpart literally states that no reply is needed ("返信不要です") are classified as skip.
- Cold inbound messages (we have not written to the counterpart yet) are checked for unsolicited sales, recruiting, and spam *before* the escalation rules, so a vendor pitch that mentions 料金, 手数料, or a meeting is classified as 返信不要 instead of 要確認. Follow thanks or cheering with nothing to answer, and link-only announcements, are also 返信不要. Prospects asking us for help (「ご相談したい」「お願いしたい」), acquaintances, and ongoing conversations are never skipped by these rules.
- When an escalation rule fires on a cold message and Gemini is configured, Gemini is asked only whether it is unsolicited promotion; it may downgrade it to 返信不要 but can never turn it into an automatic reply.
- A bare acknowledgment of our last reply ("了解です！") is 返信不要 (会話の区切り) rather than a "承知しました" draft.
- Gemini calls retry transient failures (429/5xx/timeouts, malformed JSON) with backoff (`GEMINI_MAX_RETRIES`, default 2). A Gemini draft that fails the content gate is rewritten once with the violation explained; only if the rewrite also fails is the item escalated.
- Bulk triage (`すべてを振り分け`) never overwrites a classification that a human already saved; only the explicit per-thread **再振り分け** button re-runs triage on such items.
- Reply drafts are grounded in the conversation: they must not invent facts, deliverables, dates, prices, links, or commitments, and messages that cannot be answered responsibly are escalated instead of drafted.

## Data persistence

Changes are stored in `threads.json` inside the data directory (`.data/` by default, override with `DATA_DIR`) so they survive a server restart. Writes are atomic (write to a temp file, then rename), so a crash mid-write cannot corrupt the existing file. The directory is ignored by Git because it can contain contact names, message content, and internal notes.

Known limitations — plan around them honestly:

- This is local JSON file persistence for an MVP, not a production database. There are **no automatic backups and no retention policy**; making a copy of the data directory is the backup mechanism.
- Ephemeral hosting filesystems may not preserve this data across redeploys. Do not evaluate or run the client week on a host that discards its disk.
- The file holds the entire dataset in memory; `MAX_THREADS` (default 5000) bounds growth.
- There is no multi-user isolation: everyone who can reach the API sees and can modify all conversations. Keep it on loopback or behind a proxy (see "Security and deployment").

## Validation and metrics

| Command | What it covers |
| --- | --- |
| `npm test` | Unit tests for the classification rules, the content safety gate, reply-draft quality, the bulk-triage guard, and classification correction-rate tracking. |
| `npm run lint` | Oxlint static analysis. |
| `npm run build` | Production build of the frontend into `dist/`. |
| `npm run test:browser` | Real-browser UI checks at six viewports (1440×900, 1280×800, 1024×768, 820×1180, 390×844, 360×800): overflow, inbox sizing, independent pane scrolling, dashboard, criteria, the simulation modal, completed-thread restrictions and bulk triage. Writes screenshots to `screenshots/`. |
| `npm run test:smoke` | End-to-end smoke of the *built* bundle against a running production server: serving, SPA fallback, inbox, triage, draft generation, memo persistence, simulation, dashboard, criteria and the mobile layout. |
| `node tests/api-security.test.mjs` (via `npm test`) | Boots real production-mode server instances on temporary data directories and verifies CORS, token auth, rate limiting, fail-closed startup, reset protection, import/action validation, and that API keys never appear in responses. |

The two browser suites need `playwright-core` (already a devDependency) plus a locally installed Chrome or Chromium. They do **not** download a browser. Override the executable with `CHROME_PATH` if yours is in a non-standard location:

```bash
CHROME_PATH="/path/to/chrome" npm run test:browser
```

`test:browser` expects the dev server running on `http://localhost:3000` (override with `BASE_URL`). `test:smoke` expects a production server (override with `SMOKE_BASE`, default `http://localhost:3100`) started with `ALLOW_SAMPLE_RESET=true` — it calls `POST /api/reset-samples` at the end and therefore **must only be pointed at a disposable instance with a disposable data directory** (set `DATA_DIR` to a temp path), never at a server holding real conversations.

GitHub Actions runs `npm test`, `npm run build`, and `npm run lint` on pushes and pull requests. The two browser suites are local-only and are not part of CI.

The dashboard (**検証・計測**) shows only measured values. Nothing is compared against assumed or reference figures, and the time reduction appears only once the 10-item manual baseline is complete.

### Human classification correction rate

The first AI-assigned classification of each conversation is preserved separately as `original_classification` and is never overwritten by a human override or a later re-triage. Its `decided_by` records which stage produced it: `rule` (machine rules), `llm` (Gemini), or `fallback` (template path used when Gemini is not configured or failed after retries — counted separately, never as a machine rule).

- **Correction** — the final *action* (自動 / 要確認 / 返信不要) differs from the original. This matches the client's 10/15–21 report, which counted action changes only. A category relabel with the same action is reported separately as `categoryOnlyChanges` and is not a correction. Editing an item repeatedly contributes at most one correction; editing back to the original removes it.
- **分類を直した割合** — `(corrected ÷ eligible) × 100`, where eligible items have an original AI classification and completed human review (`human_reviewed_at`). Shown as `—` when nothing is eligible. Target ≤ 15 %.
- **判定元別の修正率 / 直し方の内訳** — the same items split by original source (Gemini / 機械ルール / テンプレート) and by transition (e.g. `escalate→skip` = 要確認→返信不要), the same shape as the client's report.

Records without a preserved original classification are excluded from both counts instead of being counted as uncorrected.

**Known caveat on the denominator.** Approving or completing an item evidences review of the whole item, but only saving the classification panel (`分類を修正` → 保存) proves the classification itself was checked. How review was evidenced is recorded in `human_reviewed_via` (`update_classification`, `approve`, `complete`). `GET /api/metrics` returns `correctionRate.reviewEvidence`, which splits the eligible/corrected totals by that evidence; for a stricter reading use the `classificationUpdate` bucket.

### One-week evaluation procedure

The client's targets are **classification correction rate ≤ 15 %**, **drafts usable as-is or with light edits ≥ 70 %**, and **handling time for the first 10 items done by hand** as a comparison baseline. These are targets to evaluate, not guaranteed outcomes.

1. **Classification.** Work items through the normal review flow (correct via 分類を修正, approve/complete). Read **分類を直した割合** on the dashboard or `correctionRate` in `GET /api/metrics`.
2. **Drafts.** Rate every AI draft (also possible after completion) as **そのまま使える** (`helpful`), **軽い修正で使える** (`minor_edit`), or **書き直しが必要** (`poor`). Usability = `(helpful + minor_edit) ÷ rated × 100`, the client's 「そのまま〜軽い修正で使えた割合」. A rating is cleared when the draft is regenerated, so rate after the final regeneration.
3. **Manual baseline (first 10 items).** Press **手作業で計測** on an open item: the AI classification, draft, and inbox hints are hidden while the stopwatch runs. Handle the item yourself (decide and write the reply), then press **計測を終了して記録**. The time is stored with `mode: "manual"` and a timestamp in `handling_time_records`. Normal handling is timed automatically (`mode: "mvp"`) whenever a workflow action runs. The dashboard compares the two averages once 10 manual items exist.

For a date-scoped report, save a JSON export (`GET /api/export`) and run `node scripts/evaluate-week.mjs --input <export.json> --start <ISO 8601 with timezone> --end <ISO 8601 with timezone>`. The report includes the per-source breakdown, the manual baseline (from in-app manual records in the window, or from an operator log passed with `--handling-log`), and MVP-assisted time with the reduction against the baseline. It refuses timezone-less `--start`/`--end` values, ignores duplicate thread IDs, excludes (and reports) ratings without `quality_rated_at`, and supports `--target-correction-max` / `--target-usability-min` (defaults 15 and 70).

## Safety boundary

- Human review remains required for sensitive or uncertain messages.
- A non-empty draft is required before approval.
- No automatic external message delivery is implemented.
- Keep API credentials and real conversation data out of commits and public logs.

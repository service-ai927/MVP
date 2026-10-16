/**
 * Production smoke test. Targets an already-running production server (npm start).
 *   SMOKE_BASE=http://localhost:3100 node tests/browser/production-smoke.mjs
 *
 * Real endpoints used (from server.mjs):
 *   GET  /api/health                     -> { ok, threadsCount, hasGeminiKey }
 *   GET  /api/threads                    -> { ok, threads: [...] }
 *   POST /api/threads                    -> simulate an inbound reply
 *   PUT  /api/threads/:id/memo           -> { memo, handle?, name? }
 *   POST /api/threads/:id/generate-draft
 *   POST /api/triage-all
 *   POST /api/reset-samples              -> restore the demo set
 */
import { chromium } from "playwright-core";
import { existsSync, readFileSync } from "node:fs";

const BASE = process.env.SMOKE_BASE || "http://localhost:3100";
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter(Boolean);

const results = [];
let failures = 0;
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  if (!ok) failures += 1;
}
async function api(path, opts) {
  const r = await fetch(`${BASE}${path}`, opts);
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON is expected for HTML */ }
  return { status: r.status, text, json };
}
const list = (j) => j?.threads ?? j ?? [];

// ---------- 1. Serving layer ----------
const health = await api("/api/health");
check("health endpoint responds", health.status === 200 && health.json?.ok === true, JSON.stringify(health.json));
check("server loaded the demo thread set", (health.json?.threadsCount ?? 0) > 0, `threadsCount=${health.json?.threadsCount}`);
check("no Gemini key configured (expected for this run)", health.json?.hasGeminiKey === false, `hasGeminiKey=${health.json?.hasGeminiKey}`);

const index = await api("/");
check("SPA index.html served on /", index.status === 200 && /<div id="root">/.test(index.text), `status=${index.status}`);
check("index declares Japanese lang", /<html[^>]*\blang="ja"/.test(index.text), (index.text.match(/<html[^>]*>/) || [""])[0]);

const deepLink = await api("/some/client/route");
check("SPA deep-link falls back to index.html", deepLink.status === 200 && /<div id="root">/.test(deepLink.text), `status=${deepLink.status}`);

const notApi = await api("/api/does-not-exist");
check("unknown API route 404s instead of serving HTML", notApi.status === 404 && !/<div id="root">/.test(notApi.text), `status=${notApi.status}`);

// ---------- 2. Inbox ----------
const pristine = await api("/api/threads");
const pristineText = pristine.text;
check("GET /api/threads returns the demo set", pristine.status === 200 && list(pristine.json).length >= 10, `count=${list(pristine.json).length}`);
check("threads have anonymised counterparts only", list(pristine.json).every((t) => /^相手|^New Contact$/.test(t.counterpart?.id ?? "")), "all counterpart ids match 相手*");

// ---------- 3. Bulk triage ----------
const triage = await api("/api/triage-all", { method: "POST", headers: { "content-type": "application/json" } });
check("POST /api/triage-all responds ok", triage.status === 200 && triage.json?.ok === true, JSON.stringify(triage.json));
const afterTriage = await api("/api/threads");
check("bulk triage left completed threads untouched", afterTriage.text === pristineText, "thread payload byte-identical");

// ---------- 4. Draft generation (template fallback, no key) ----------
const target = list(afterTriage.json).find((t) => t.classification?.action !== "skip") ?? list(afterTriage.json)[0];
const targetId = target?.thread?.id;
let draftOk = false, draftDetail = "no target thread";
if (targetId) {
  const gen = await api(`/api/threads/${encodeURIComponent(targetId)}/generate-draft`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tone: "friendly" }),
  });
  draftOk = gen.status === 200 && gen.json?.ok === true;
  draftDetail = `status=${gen.status} body=${JSON.stringify(gen.json).slice(0, 200)}`;
}
check("POST /generate-draft works via template fallback (no API key)", draftOk, draftDetail);

// ---------- 5. Memo write + read-back ----------
let memoOk = false, memoDetail = "no target thread";
if (targetId) {
  const setMemo = await api(`/api/threads/${encodeURIComponent(targetId)}/memo`, {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ memo: "smoke-test-memo" }),
  });
  const verify = await api(`/api/threads/${encodeURIComponent(targetId)}`);
  const got = verify.json?.thread?.counterpart?.memo;
  memoOk = setMemo.status === 200 && got === "smoke-test-memo";
  memoDetail = `put=${setMemo.status} readback=${JSON.stringify(got)}`;
}
check("PUT /memo persists and reads back", memoOk, memoDetail);

// ---------- 6. Simulation ----------
const sim = await api("/api/threads", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({
    contactName: "相手スモーク", handle: "@smoke", platform: "x", account: "Lily",
    memo: "smoke", messageText: "リリース前の動作確認です。よろしくお願いします。",
  }),
});
check("POST /api/threads simulates an inbound reply", sim.status === 200 && sim.json?.ok === true, `status=${sim.status}`);
const afterSim = await api("/api/threads");
const simThread = list(afterSim.json).find((t) => t.counterpart?.handle === "@smoke");
check("simulated thread lands in the inbox", Boolean(simThread), `classified as ${simThread?.classification?.action}/${simThread?.classification?.category}`);

// ---------- 7. Real browser against the production bundle ----------
const chromePath = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!chromePath) {
  console.error("No local Chrome/Chromium found. Set CHROME_PATH to a Chrome executable and re-run.");
  process.exit(2);
}
const browser = await chromium.launch({ executablePath: chromePath, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const consoleErrors = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));

await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".thread-card", { timeout: 30000 });
const cards = await page.locator(".thread-card").count();
check("production UI renders thread cards", cards > 0, `${cards} cards`);
check("production UI shows the simulated contact", (await page.locator(".thread-card", { hasText: "相手スモーク" }).count()) > 0, "相手スモーク visible");

await page.click('.tab-btn:has-text("5日間の検証")');
await page.waitForSelector(".metrics-view .stat-card", { timeout: 15000 });
check("dashboard tab renders 4 stat cards", (await page.locator(".metrics-view .stat-card").count()) === 4, `${await page.locator(".metrics-view .stat-card").count()} cards`);

await page.click('.tab-btn:has-text("判定基準")');
await page.waitForSelector(".guide-view", { timeout: 15000 });
check("criteria tab renders", (await page.locator(".guide-view .guide-card").count()) > 0, `${await page.locator(".guide-view .guide-card").count()} cards`);

await page.click('.tab-btn:has-text("受信箱")');
await page.waitForSelector(".thread-card", { timeout: 15000 });
await page.click('button:has-text("受信メッセージを追加")');
await page.waitForSelector(".modal-overlay", { timeout: 15000 });
check("simulation modal opens in the production build", true, ".modal-overlay present");
await page.evaluate(() => document.querySelector(".modal-overlay").click());
await page.waitForSelector(".modal-overlay", { state: "detached", timeout: 10000 });
check("simulation modal closes", true, "overlay detached");

await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(500);
const mob = await page.evaluate(() => {
  const sb = document.querySelector(".sidebar");
  const list = document.querySelector(".thread-card")?.closest(".thread-list");
  return {
    hOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    sidebarH: sb ? Math.round(sb.getBoundingClientRect().height) : null,
    listH: list ? Math.round(list.getBoundingClientRect().height) : null,
  };
});
check("mobile 390x844: no horizontal overflow in the production bundle", mob.hOverflow <= 0, JSON.stringify(mob));
check("mobile 390x844: sidebar above the old 46vh cap", (mob.sidebarH ?? 0) > 400, `sidebar=${mob.sidebarH}px`);
check("mobile 390x844: thread list has real height", (mob.listH ?? 0) >= 250, `list=${mob.listH}px`);

check("no console/page errors in the production UI", consoleErrors.length === 0, consoleErrors.join(" | ") || "none");
await browser.close();

// ---------- 8. Restore ----------
// reset-samples reloads src/sample-threads.json, so it restores the *sample*
// set, not whatever state existed before this test ran. Verify against the
// sample's own ids and confirm no smoke artifacts survive, rather than
// comparing to the pre-smoke snapshot (which may contain local edits).
const sampleIds = new Set(
  JSON.parse(readFileSync(new URL("../../src/sample-threads.json", import.meta.url), "utf-8"))
    .threads.map((t) => t?.thread?.id)
    .filter(Boolean)
);
const reset = await api("/api/reset-samples", { method: "POST", headers: { "content-type": "application/json" } });
const afterReset = await api("/api/threads");
const resetIds = list(afterReset.json).map((t) => t?.thread?.id);
const artifacts = list(afterReset.json).filter(
  (t) => t.counterpart?.handle === "@smoke" || t.counterpart?.memo === "smoke-test-memo"
);
check(
  "POST /api/reset-samples restores the sample set",
  reset.status === 200 && resetIds.length > 0 && resetIds.every((id) => sampleIds.has(id)),
  `reset=${reset.status} loaded=${resetIds.length} sampleIds=${sampleIds.size}`
);
check("no smoke-test artifacts survive the reset", artifacts.length === 0, `${artifacts.length} leftover threads`);

// Data integrity: every entry in the sample file must survive loading. A
// duplicate thread.id makes normalizeThreads() drop a thread silently, so the
// inbox would quietly show fewer contacts than the benchmark set defines.
const sampleEntries = JSON.parse(readFileSync(new URL("../../src/sample-threads.json", import.meta.url), "utf-8"))
  .threads.length;
check(
  "sample data loads without dropping threads",
  resetIds.length === sampleEntries,
  `sample file defines ${sampleEntries} threads, ${resetIds.length} loaded - duplicate thread.id?`
);

console.log("\n=== Production smoke test ===");
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}\n      ${r.detail}`);
console.log(`\nTotal: ${results.length}, passed: ${results.length - failures}, failed: ${failures}`);
process.exit(failures ? 1 : 0);

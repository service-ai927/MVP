/**
 * Real-browser UI regression checks (Playwright core + local Chrome).
 *
 * Usage:  npm run test:browser
 *
 * Not named *.test.mjs on purpose so the default `node --test` unit runner in
 * `npm test` does not try to execute it.
 */
import { chromium } from "playwright-core";
import { mkdirSync, existsSync } from "node:fs";
import path from "node:path";

const BASE = process.env.BASE_URL || "http://localhost:3000";
const SHOT_DIR = process.env.SHOT_DIR || "screenshots";
const LABEL = process.env.SHOT_LABEL || "";
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter(Boolean);

const VIEWPORTS = [
  { name: "desktop-1440x900", w: 1440, h: 900, desktop: true },
  { name: "laptop-1280x800", w: 1280, h: 800, desktop: true },
  { name: "tablet-1024x768", w: 1024, h: 768, desktop: true },
  { name: "tablet-portrait-820x1180", w: 820, h: 1180, desktop: true },
  { name: "mobile-390x844", w: 390, h: 844, desktop: false },
  { name: "mobile-360x800", w: 360, h: 800, desktop: false },
];
const SCREENSHOT_VIEWPORTS = new Set(["desktop-1440x900", "mobile-390x844", "mobile-360x800"]);

const results = [];
const measurements = [];
let failures = 0;

function check(name, ok, detail) {
  results.push({ name, ok, detail });
  if (!ok) failures += 1;
}

function findChrome() {
  return CHROME_CANDIDATES.find((p) => existsSync(p));
}

const MEASURE = () => {
  const de = document.documentElement;
  const q = (s) => document.querySelector(s);
  const box = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height), width: Math.round(r.width) };
  };
  const sidebar = q(".sidebar");
  const list = q(".thread-list");
  const cards = Array.from(document.querySelectorAll(".thread-card"));
  const lr = list ? list.getBoundingClientRect() : null;
  const partiallyVisible = lr
    ? cards.filter((c) => {
        const cr = c.getBoundingClientRect();
        return cr.bottom > lr.top + 2 && cr.top < lr.bottom - 2;
      }).length
    : 0;
  const fullyVisible = lr
    ? cards.filter((c) => {
        const cr = c.getBoundingClientRect();
        return cr.top >= lr.top - 1 && cr.bottom <= lr.bottom + 1;
      }).length
    : 0;
  const body = q(".conversation-body");
  return {
    lang: de.lang || document.documentElement.getAttribute("lang"),
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    docScrollWidth: de.scrollWidth,
    docClientWidth: de.clientWidth,
    docScrollHeight: de.scrollHeight,
    horizontalOverflowPx: de.scrollWidth - de.clientWidth,
    verticalOverflowPx: de.scrollHeight - window.innerHeight,
    topbar: box(q(".topbar")),
    workspace: box(q(".workspace")),
    sidebar: box(sidebar),
    threadList: box(list),
    inboxHeaderHeight: sidebar && lr ? Math.round(lr.top - sidebar.getBoundingClientRect().top) : null,
    threadListScrollable: !!list && list.scrollHeight > list.clientHeight + 1,
    threadListMaxScroll: list ? list.scrollHeight - list.clientHeight : 0,
    threadCardCount: cards.length,
    visibleThreadCardsPartial: partiallyVisible,
    visibleThreadCardsFull: fullyVisible,
    avgCardHeight: cards.length ? Math.round(cards.reduce((a, c) => a + c.getBoundingClientRect().height, 0) / cards.length) : 0,
    conversation: box(q(".conversation")),
    convBody: box(body),
    convBodyScrollable: !!body && body.scrollHeight > body.clientHeight + 1,
    // The body is the internal scroller when it has overflow-y auto/scroll and is
    // bounded by the viewport. Whether the sample content overflows depends on
    // its length, so overflow alone is not required.
    convBodyIsScroller:
      !!body &&
      ["auto", "scroll"].includes(getComputedStyle(body).overflowY) &&
      body.getBoundingClientRect().bottom <= window.innerHeight + 1,
    inboxHeaderParts:
      sidebar && list
        ? Array.from(sidebar.children).map((el) => ({
            cls: el.className || "(inline)",
            h: Math.round(el.getBoundingClientRect().height),
          }))
        : [],
    workspaceDisplay: q(".workspace") ? getComputedStyle(q(".workspace")).display : null,
    sidebarMaxHeight: sidebar ? getComputedStyle(sidebar).maxHeight : null,
    threadListMaxHeight: list ? getComputedStyle(list).maxHeight : null,
    selectedName: q(".person h2") ? q(".person h2").textContent.trim() : null,
    headerBadge: (() => {
      const b = q(".conversation-header .badge");
      return b ? { text: b.textContent.trim(), cls: b.className } : null;
    })(),
    japaneseLabels: {
      inbox: !!q(".sidebar-heading h2") && q(".sidebar-heading h2").textContent.includes("受信箱"),
      tabs: Array.from(document.querySelectorAll(".tab-btn")).map((b) => b.textContent.trim()),
      addMessage: Array.from(document.querySelectorAll("button")).some((b) => b.textContent.includes("受信メッセージを追加")),
    },
  };
};

async function loadPage(page, errors) {
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(`console: ${msg.text()}`);
  });
  page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".thread-card", { timeout: 20000 });
}

async function main() {
  const executablePath = findChrome();
  if (!executablePath) throw new Error("No local Chrome/Chromium found; set CHROME_PATH.");
  mkdirSync(SHOT_DIR, { recursive: true });

  const browser = await chromium.launch({ executablePath, headless: true });
  const allErrors = [];

  for (const vp of VIEWPORTS) {
    const errors = [];
    const context = await browser.newContext({ viewport: { width: vp.w, height: vp.h } });
    const page = await context.newPage();
    await loadPage(page, errors);
    allErrors.push(...errors.map((e) => `[${vp.name}] ${e}`));

    const m = await page.evaluate(MEASURE);
    const tag = `${vp.name}`;

    measurements.push({
      viewport: vp.name,
      size: `${vp.w}x${vp.h}`,
      docOverflowX: m.horizontalOverflowPx,
      docOverflowY: m.verticalOverflowPx,
      topbar: m.topbar?.height ?? null,
      workspace: m.workspace?.height ?? null,
      sidebar: m.sidebar?.height ?? null,
      sidebarMaxHeight: m.sidebarMaxHeight,
      inboxHeader: m.inboxHeaderHeight,
      headerShareOfSidebar:
        m.sidebar?.height && m.inboxHeaderHeight != null
          ? `${Math.round((m.inboxHeaderHeight / m.sidebar.height) * 100)}%`
          : null,
      threadList: m.threadList?.height ?? null,
      threadListMaxHeight: m.threadListMaxHeight,
      threadListMaxScroll: m.threadListMaxScroll,
      avgCardHeight: m.avgCardHeight,
      cardsVisible: `${m.visibleThreadCardsPartial} partial / ${m.visibleThreadCardsFull} full (of ${m.threadCardCount})`,
      headerParts: m.inboxHeaderParts.map((p) => `${p.cls}=${p.h}`).join(", "),
    });

    check(
      `${tag}: no horizontal overflow`,
      m.horizontalOverflowPx <= 0,
      `scrollWidth ${m.docScrollWidth} vs clientWidth ${m.docClientWidth} (${m.horizontalOverflowPx}px)`
    );
    if (vp.desktop) {
      check(
        `${tag}: no vertical document overflow`,
        m.verticalOverflowPx <= 0,
        `scrollHeight ${m.docScrollHeight} vs innerHeight ${m.innerHeight} (${m.verticalOverflowPx}px)`
      );
      check(
        `${tag}: panes fill the viewport`,
        m.workspace && Math.abs(m.workspace.bottom - m.innerHeight) <= 1,
        `workspace ${JSON.stringify(m.workspace)}`
      );
      check(`${tag}: conversation body scrolls internally`, m.convBodyIsScroller, `convBody ${JSON.stringify(m.convBody)} overflowing=${m.convBodyScrollable}`);
    }

    check(
      `${tag}: inbox thread list scrolls independently`,
      m.threadListScrollable && m.threadListMaxScroll > 0,
      `maxScroll ${m.threadListMaxScroll}, list ${JSON.stringify(m.threadList)}`
    );

    // Prove the inbox list really scrolls on its own.
    const listScroll = await page.evaluate(() => {
      const l = document.querySelector(".thread-list");
      const before = l.scrollTop;
      l.scrollTop = l.scrollHeight;
      const after = l.scrollTop;
      l.scrollTop = 0;
      return { before, after, docScrollAfter: document.documentElement.scrollTop };
    });
    check(
      `${tag}: inbox list scrollTop actually changes`,
      listScroll.after > 0,
      JSON.stringify(listScroll)
    );

    check(`${tag}: at least 2 thread cards visible in the inbox`, m.visibleThreadCardsPartial >= 2, `${m.visibleThreadCardsPartial} partial / ${m.visibleThreadCardsFull} full of ${m.threadCardCount}`);

    // Japanese UI
    check(`${tag}: document language is Japanese`, m.lang === "ja", `lang=${m.lang}`);
    check(`${tag}: Japanese labels present`, m.japaneseLabels.inbox && m.japaneseLabels.addMessage, JSON.stringify(m.japaneseLabels));

    if (SCREENSHOT_VIEWPORTS.has(vp.name)) {
      await page.screenshot({ path: path.join(SHOT_DIR, `${vp.name}${LABEL}.png`), fullPage: false });
    }

    // ---- Completed-thread restrictions -------------------------------------
    const completed = await page.evaluate(() => {
      const badge = document.querySelector(".conversation-header .badge");
      const conv = document.querySelector(".conversation");
      const forbidden = ["承認", "再振り分け", "分類を修正", "保留にする", "差し戻す", "返信案を編集", "返信案を評価"];
      const buttons = conv ? Array.from(conv.querySelectorAll("button")).map((b) => b.textContent.replace(/\s+/g, " ").trim()) : [];
      return {
        name: document.querySelector(".person h2")?.textContent.trim() || null,
        badge: badge ? badge.textContent.trim() : null,
        badgeClass: badge ? badge.className : null,
        hasCompletionPanel: !!document.querySelector(".completion-panel"),
        buttons,
        forbiddenButtons: buttons.filter((t) => forbidden.some((f) => t.includes(f))),
      };
    });
    check(`${tag}: selected thread is the completed sample`, completed.name === "相手A", `selected=${completed.name}`);
    check(`${tag}: completed badge shows 完了`, completed.badge === "完了" && /completed/.test(completed.badgeClass || ""), JSON.stringify({ badge: completed.badge, cls: completed.badgeClass }));
    check(`${tag}: completion panel rendered`, completed.hasCompletionPanel, JSON.stringify(completed.buttons));
    check(`${tag}: no processing buttons on completed thread`, completed.forbiddenButtons.length === 0, JSON.stringify(completed.forbiddenButtons));

    // ---- Tabs ---------------------------------------------------------------
    await page.click('.tab-btn:has-text("検証・計測")');
    await page.waitForSelector(".metrics-view .stat-card", { timeout: 10000 });
    const metricsCards = await page.locator(".metrics-view .stat-card").count();
    check(`${tag}: dashboard tab renders`, metricsCards === 4, `${metricsCards} stat cards`);

    await page.click('.tab-btn:has-text("判定基準")');
    await page.waitForSelector(".guide-view", { timeout: 10000 });
    const guideCards = await page.locator(".guide-view .guide-card").count();
    check(`${tag}: criteria tab renders`, guideCards > 0, `${guideCards} guide cards`);

    await page.click('.tab-btn:has-text("受信箱")');
    await page.waitForSelector(".thread-card", { timeout: 10000 });

    // ---- Simulation modal ---------------------------------------------------
    await page.click('button:has-text("受信メッセージを追加")');
    await page.waitForSelector(".modal-overlay", { timeout: 10000 });
    const modal = await page.evaluate(() => {
      const content = document.querySelector(".modal-content");
      const r = content.getBoundingClientRect();
      return {
        inputs: document.querySelectorAll(".modal-content input").length,
        textarea: document.querySelectorAll(".modal-content textarea").length,
        select: document.querySelectorAll(".modal-content select").length,
        buttons: Array.from(document.querySelectorAll(".modal-content button")).map((b) => b.textContent.trim()),
        overflowY: r.bottom > window.innerHeight || r.top < 0,
        overflowX: r.right > window.innerWidth || r.left < 0,
        docHorizontal: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    });
    check(
      `${tag}: simulation modal opens with form controls`,
      modal.inputs >= 4 && modal.textarea >= 1 && modal.select >= 1,
      JSON.stringify(modal)
    );
    check(`${tag}: modal stays inside the viewport`, !modal.overflowX && modal.docHorizontal <= 0, JSON.stringify({ overflowX: modal.overflowX, docHorizontal: modal.docHorizontal }));
    await page.evaluate(() => document.querySelector(".modal-overlay").click());
    await page.waitForSelector(".modal-overlay", { state: "detached", timeout: 5000 });

    // ---- Bulk triage must not touch completed threads -----------------------
    const before = await (await page.request.get(`${BASE}/api/threads`)).text();
    await Promise.all([
      page.waitForResponse((r) => r.url().includes("/api/triage-all") && r.request().method() === "POST"),
      page.click('button[title="未処理の会話をルールとAIで振り分け"]'),
    ]);
    const after = await (await page.request.get(`${BASE}/api/threads`)).text();
    check(`${tag}: bulk triage leaves completed threads untouched`, before === after, before === after ? "threads payload unchanged" : "threads payload CHANGED");

    check(`${tag}: no console/page errors`, errors.length === 0, errors.length ? errors.join(" | ") : "none");

    await context.close();
  }

  await browser.close();

  console.log("\n=== Layout measurements ===");
  for (const row of measurements) {
    console.log(`\n${row.viewport} (${row.size})`);
    console.log(`  document overflow: x=${row.docOverflowX}px y=${row.docOverflowY}px`);
    console.log(`  topbar=${row.topbar} workspace=${row.workspace} sidebar=${row.sidebar} (max-height ${row.sidebarMaxHeight})`);
    console.log(`  inbox header=${row.inboxHeader} (${row.headerShareOfSidebar} of sidebar): ${row.headerParts}`);
    console.log(
      `  thread list=${row.threadList} (max-height ${row.threadListMaxHeight}, max scroll ${row.threadListMaxScroll}), avg card=${row.avgCardHeight}, visible=${row.cardsVisible}`
    );
  }

  console.log("\n=== Browser check results ===");
  for (const r of results) {
    console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}\n      ${r.detail}`);
  }
  console.log(`\nTotal checks: ${results.length}, passed: ${results.length - failures}, failed: ${failures}`);
  if (allErrors.length) {
    console.log("\nCollected console/page errors:");
    for (const e of allErrors) console.log(`  ${e}`);
  }
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});

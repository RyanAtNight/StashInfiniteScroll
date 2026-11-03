// Browser checks against a sandbox Stash (see sandbox.mjs): node test.mjs <port> [label]
// Drives headless Chrome, scrolling with the mouse wheel like a person would, and writes
// .sandbox/report-<label>.json. ONLY=<regex> runs matching checks; TRACE=1 prints the plugin trace.
import { chromium } from "playwright-core";
import { mkdirSync, writeFileSync } from "node:fs";

const port = process.argv[2];
const label = process.argv[3] || port;
const base = `http://127.0.0.1:${port}`;
const report = { label, base, version: null, results: [], errors: [] };

async function gql(query, variables = {}) {
  const r = await fetch(`${base}/graphql`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query, variables }) });
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors));
  return j.data;
}
report.version = (await gql("{ version { version hash } }")).version;

// installed Chrome by default; BROWSER_CHANNEL="" uses Playwright's own Chromium (npx playwright install chromium)
const channel = process.env.BROWSER_CHANNEL ?? "chrome";
const browser = await chromium.launch(channel ? { channel, headless: true } : { headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
let currentTest = "setup";
page.on("pageerror", (e) => report.errors.push({ test: currentTest, kind: "pageerror", text: String(e.stack || e).slice(0, 600) }));
page.on("console", (m) => {
  if (m.type() === "error" || (m.type() === "warning" && m.text().includes("InfiniteScroll"))) {
    report.errors.push({ test: currentTest, kind: m.type(), text: m.text().slice(0, 400), at: m.location().url });
  }
});
if (process.env.TRACE) {
  page.on("console", (m) => { if (/^\[InfiniteScroll\]/.test(m.text())) console.log("   trace:", m.text().split("\n")[0].slice(0, 160)); });
  await page.addInitScript(() => { Object.defineProperty(window, "InfiniteScrollDebug", { configurable: true, set(v) { v.trace = true; Object.defineProperty(window, "InfiniteScrollDebug", { value: v, writable: true }); } }); });
  await page.addInitScript(() => { for (const k of ["pushState", "replaceState"]) { const o = history[k].bind(history); history[k] = (s, t, u) => { console.debug("[InfiniteScroll] url", k[0], s && s.key, String(u).slice(String(u).indexOf("?"))); return o(s, t, u); }; } });
}
// keep videos silent and paused unless a test needs them
await page.addInitScript(() => {
  document.addEventListener("play", (e) => { e.target.muted = true; }, true);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const state = () => page.evaluate(() => {
  const d = window.InfiniteScrollDebug;
  const r = d && [...d.activeLists][0];
  return { loaded: !!d, active: !!r, name: r && r.name, mode: r && r.mode, items: r ? r.itemCount : 0, total: r ? r.st.count : null, p: new URLSearchParams(location.search).get("p"), y: Math.round(scrollY) };
});

async function dismissModals() {
  for (let i = 0; i < 3; i++) {
    const closed = await page.evaluate(() => {
      const m = document.querySelector(".modal.show");
      if (!m) return false;
      const b = [...m.querySelectorAll("button")].find((x) => /close|ok|dismiss|got it/i.test(x.textContent));
      if (b) { b.click(); return true; }
      return false;
    });
    if (!closed) return;
    await sleep(400);
  }
}

async function open(path) {
  await page.goto(base + path, { waitUntil: "domcontentloaded" });
  await dismissModals();
  for (let i = 0; i < 60; i++) {
    const s = await state();
    if (s.active && s.items > 0) break;
    await sleep(150);
  }
  await sleep(500);
  await dismissModals();
}

// the element that actually scrolls the list (window or an inner box)
async function scrollTarget() {
  return page.evaluate(() => {
    const c = document.querySelector(".isc-list");
    const first = c && (c.querySelector("tbody > tr, .wall-item, .search-item, [data-isc-item], .grid-card, .card"));
    let el = first ? first.parentElement : null;
    while (el && el !== document.body) {
      const oy = getComputedStyle(el).overflowY;
      if ((oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight + 1) {
        const r = el.getBoundingClientRect();
        return { inner: true, x: r.left + r.width / 2, y: r.top + Math.min(r.height / 2, 300), cls: el.className.toString().slice(0, 40) };
      }
      el = el.parentElement;
    }
    return { inner: false, x: 640, y: 500 };
  });
}

async function wheelToEnd(maxSteps = 80) {
  const t = await scrollTarget();
  await page.mouse.move(t.x, t.y);
  let s = await state();
  for (let i = 0; i < maxSteps && s.items < s.total; i++) {
    await page.mouse.wheel(0, 700);
    await sleep(120);
    s = await state();
  }
  // let the last batch settle, then a few more turns to the very bottom
  for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, 1500); await sleep(150); }
  await sleep(800);
  return { target: t, ...(await state()) };
}

const headerCheck = () => page.evaluate(() => {
  const tb = document.querySelector(".item-list-container .filtered-list-toolbar");
  if (!tb) return { toolbar: false };
  const b = tb.getBoundingClientRect();
  const ctl = [...tb.querySelectorAll("button, input")].filter((x) => x.getBoundingClientRect().width > 0);
  const blocked = ctl.filter((x) => {
    const r = x.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !(hit && (x.contains(hit) || hit.contains(x) || tb.contains(hit)));
  }).map((x) => (x.title || x.className || x.tagName).toString().slice(0, 30));
  const nav = document.querySelector(".top-nav, .navbar.fixed-top");
  const dh = document.querySelector(".sticky.detail-header");
  return { toolbar: true, top: Math.round(b.top), navBottom: nav ? Math.round(nav.getBoundingClientRect().bottom) : null, detailHeaderBottom: dh ? Math.round(dh.getBoundingClientRect().bottom) : null, onScreen: b.bottom > 0 && b.top < innerHeight, controls: ctl.length, blocked };
});

const dupCheck = () => page.evaluate(() => {
  const c = document.querySelector(".isc-list");
  if (!c) return null;
  const links = [...c.querySelectorAll("a[href]")].map((a) => a.getAttribute("href").split("?")[0]).filter((h) => /^\/(scenes|images|galleries|performers|studios|tags|groups)\/\d+$/.test(h));
  // each card links to its own item, often more than once; count per card container instead
  const cards = [...c.querySelectorAll(".grid-card, .wall-item, tbody > tr")];
  const own = cards.map((el) => { const a = el.querySelector("a[href]"); return a && a.getAttribute("href").split("?")[0]; }).filter(Boolean);
  const seen = new Set(); const dups = [];
  for (const h of own) { if (seen.has(h)) dups.push(h); seen.add(h); }
  return { rendered: cards.length, placeholders: c.querySelectorAll(".isc-ph").length, dups: dups.slice(0, 5) };
});

async function test(name, fn) {
  if (process.env.ONLY && !new RegExp(process.env.ONLY).test(name)) return;
  currentTest = name;
  const t0 = Date.now();
  const res = { name, ok: true, notes: [] };
  try {
    await fn(res);
  } catch (e) {
    res.ok = false;
    res.notes.push("threw: " + String(e && e.message || e).slice(0, 300));
  }
  res.ms = Date.now() - t0;
  report.results.push(res);
  console.log(`${res.ok ? "PASS" : "FAIL"} ${name} ${res.notes.join(" | ")}`);
}
const check = (res, cond, msg) => { if (!cond) { res.ok = false; res.notes.push(msg); } };

const gal = (await gql("{ findGalleries(filter:{per_page:-1}) { galleries { id image_count } } }")).findGalleries.galleries.sort((a, b) => b.image_count - a.image_count)[0];

// 1. every list kind loads everything, in order, with the header usable
const routes = ["/scenes", "/images", "/galleries", "/performers", "/studios", "/tags", "/groups", "/scenes/markers",
  "/studios/1/scenes", "/studios/1/images", "/studios/1/galleries", "/performers/1/scenes", "/performers/1/images", "/performers/1/galleries",
  "/tags/1/scenes", "/tags/1/images", "/groups/1/scenes", `/galleries/${gal.id}`];
for (const path of routes) {
  await test(`list ${path}`, async (res) => {
    await open(path);
    const s0 = await state();
    check(res, s0.active, "plugin not active on this list");
    if (!s0.active) return;
    const end = await wheelToEnd();
    res.data = { list: s0.name, first: s0.items, total: s0.total, final: end.items, p: end.p, scroller: end.target.inner ? end.target.cls : "window" };
    check(res, end.items === end.total, `loaded ${end.items} of ${end.total}`);
    const d = await dupCheck();
    res.data.dom = d;
    check(res, d && d.dups.length === 0, `duplicate cards: ${d && d.dups}`);
    const sentinel = await page.evaluate(() => (document.querySelector(".isc-sentinel") || {}).textContent || "");
    if (end.total > 14) check(res, /End of results/.test(sentinel), `no end marker (${sentinel})`);
    if (end.y > 300 || end.target.inner) {
      const hdr = await headerCheck();
      res.data.header = hdr;
      check(res, hdr.toolbar && hdr.onScreen, "toolbar scrolled away");
      check(res, hdr.blocked.length === 0, `toolbar controls covered: ${hdr.blocked}`);
      if (hdr.detailHeaderBottom) check(res, hdr.top >= hdr.detailHeaderBottom - 1, `toolbar under the detail name bar (${hdr.top} < ${hdr.detailHeaderBottom})`);
      if (end.total > 28) check(res, end.p && Number(end.p) > 1, `address bar page not updated (p=${end.p})`);
    }
  });
}

// 2. other views
for (const [disp, name] of [[1, "list view"], [2, "wall view"], [3, "tagger view"]]) {
  await test(`scenes ${name}`, async (res) => {
    await open(`/scenes?disp=${disp}`);
    const s0 = await state();
    check(res, s0.active && s0.mode === disp, `not active in ${name} (mode ${s0.mode})`);
    if (!s0.active) return;
    const end = await wheelToEnd();
    res.data = { first: s0.items, final: end.items, total: end.total, scroller: end.target.inner ? end.target.cls : "window" };
    check(res, end.items === end.total, `loaded ${end.items} of ${end.total}`);
    const d = await dupCheck();
    check(res, !d || d.dups.length === 0, `duplicates: ${d && d.dups}`);
  });
}

// 3. back from a scene returns to the same place
await test("back from a scene keeps position", async (res) => {
  await open("/scenes?sortby=title&sortdir=asc");
  await wheelToEnd();
  await page.evaluate(() => window.scrollTo(0, 1600));
  await sleep(800);
  const before = await page.evaluate(() => {
    const card = [...document.querySelectorAll(".scene-card")].find((x) => { const b = x.getBoundingClientRect(); return b.top > 250 && b.bottom < innerHeight - 50; });
    const a = card && card.querySelector("a[href*='/scenes/']");
    // measure the first link with that address, the same one measured after
    const first = a && document.querySelector(`.scene-card a[href="${a.getAttribute("href")}"]`);
    return a && { href: a.getAttribute("href"), top: Math.round(first.getBoundingClientRect().top), y: Math.round(scrollY) };
  });
  const s1 = await state();
  await page.click(`.scene-card a[href="${before.href}"]`);
  await page.waitForURL(/\/scenes\/\d+/);
  await sleep(1500);
  await page.goBack();
  await sleep(2500);
  const after = await page.evaluate((href) => { const a = document.querySelector(`.scene-card a[href="${href}"]`); return { top: a ? Math.round(a.getBoundingClientRect().top) : null, y: Math.round(scrollY) }; }, before.href);
  const s2 = await state();
  res.data = { before, after, itemsBefore: s1.items, itemsAfter: s2.items };
  check(res, s2.items === s1.items, `items went from ${s1.items} to ${s2.items}`);
  check(res, after.top !== null && Math.abs(after.top - before.top) < 60, `clicked card moved from ${before.top} to ${after.top}`);
});

// 4. opening a link to a later page offers the earlier ones
await test("link to page 4 loads earlier on demand", async (res) => {
  await open("/scenes?sortby=title&sortdir=asc&p=4");
  const s0 = await state();
  const btn = await page.$(".isc-top button");
  check(res, !!btn, "no Load earlier results button");
  const firstBefore = await page.evaluate(() => { const a = document.querySelector(".scene-card a[href*='/scenes/']"); return a && a.getAttribute("href"); });
  if (btn) {
    const topBefore = await page.evaluate((h) => document.querySelector(`.scene-card a[href="${h}"]`).getBoundingClientRect().top, firstBefore);
    await btn.click();
    await sleep(1500);
    const s1 = await state();
    const topAfter = await page.evaluate((h) => { const a = document.querySelector(`.scene-card a[href="${h}"]`); return a && a.getBoundingClientRect().top; }, firstBefore);
    res.data = { before: s0.items, after: s1.items, topBefore: Math.round(topBefore), topAfter: topAfter && Math.round(topAfter) };
    check(res, s1.items > s0.items, "earlier page didn't load");
    check(res, topAfter !== null && Math.abs(topAfter - topBefore) < 60, `view jumped (${Math.round(topBefore)} -> ${topAfter && Math.round(topAfter)})`);
  }
});

// 5. select all covers every loaded item
await test("select all selects every loaded item", async (res) => {
  await open("/scenes?sortby=title&sortdir=asc");
  await wheelToEnd();
  const s = await state();
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(300);
  // tick one card, then use the selection bar's "select all"
  await page.evaluate(() => { const c = document.querySelector(".scene-card .card-check"); c && c.click(); });
  await sleep(500);
  const clicked = await page.evaluate(() => {
    const b = [...document.querySelectorAll(".selected-items-info button, .filtered-list-toolbar button")].find((x) => /select all/i.test(x.title || x.getAttribute("aria-label") || x.textContent));
    if (b) { b.click(); return true; }
    return false;
  });
  await sleep(800);
  const info = await page.evaluate(() => (document.querySelector(".selected-items-info") || {}).innerText || "");
  const n = Number((info.match(/\d+/) || [0])[0]);
  res.data = { clicked, info, loaded: s.items };
  check(res, clicked, "select all button not found");
  check(res, n === s.items, `selected ${n} of ${s.items}`);
  await page.evaluate(() => { const b = document.querySelector(".selected-items-info button"); b && b.click(); });
});

// 6. changing the sort starts a fresh list from the top
await test("sort change starts fresh", async (res) => {
  await open("/scenes?sortby=title&sortdir=asc");
  await wheelToEnd();
  const before = await state();
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(300);
  // click Stash's own sort-direction button like a person would
  const dirBtn = await page.$(".filtered-list-toolbar button[title*='Ascending' i], .filtered-list-toolbar button[title*='Descending' i], .sort-by-select .btn-secondary:not(.dropdown-toggle)");
  check(res, !!dirBtn, "sort direction button not found");
  if (dirBtn) await dirBtn.click();
  await sleep(2000);
  const after = await state();
  const first = await page.evaluate(() => (document.querySelector(".scene-card .card-section-title, .scene-card a .TruncatedText") || {}).textContent);
  res.data = { before: before.items, after: after.items, first, url: page.url().replace(base, "") };
  check(res, after.items < before.items, "list not restarted");
  check(res, /90/.test(first || ""), `first card should be the last title (${first})`);
});

// 7. image lightbox steps past the loaded images
await test("lightbox loads more images", async (res) => {
  await open("/images?sortby=path&sortdir=asc");
  const s0 = await state();
  await page.click(".image-card a, .image-card .image-card-preview");
  await sleep(1500);
  const lb = await page.$(".Lightbox");
  check(res, !!lb, "lightbox did not open");
  if (!lb) return;
  const counterText = () => page.evaluate(() => (document.querySelector(".Lightbox-header-indicator, .Lightbox-indicator") || {}).textContent || "");
  // step like a person: wait for each slide before the next key
  for (let i = 0; i < s0.items + 10; i++) {
    await page.keyboard.press("ArrowRight");
    await sleep(250);
    const m = /(\d+)\s*\/\s*(\d+)/.exec(await counterText());
    if (m && Number(m[1]) > s0.items + 2) break;
  }
  await sleep(1500);
  const s1 = await state();
  const counter = await page.evaluate(() => (document.querySelector(".Lightbox-header-indicator, .Lightbox-indicator") || {}).textContent);
  res.data = { before: s0.items, after: s1.items, counter };
  check(res, s1.items > s0.items, "stepping to the end didn't load more");
  await page.keyboard.press("Escape");
});

// 8. off-screen grid cards become placeholders, and come back
await test("off-screen cards are swapped and restored", async (res) => {
  await page.setViewportSize({ width: 1280, height: 500 });
  await open("/images?sortby=path&sortdir=asc");
  await wheelToEnd();
  const d1 = await dupCheck();
  await page.evaluate(() => window.scrollTo(0, 0));
  for (let i = 0; i < 5; i++) { await page.mouse.wheel(0, -500); await sleep(150); }
  await sleep(1000);
  const visibleOk = await page.evaluate(() => {
    const ph = [...document.querySelectorAll(".isc-ph")].filter((p) => { const r = p.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight; });
    return ph.length;
  });
  res.data = { atBottom: d1, placeholdersOnScreenAtTop: visibleOk };
  check(res, d1 && d1.placeholders > 0, "no placeholders after scrolling far");
  check(res, visibleOk === 0, `${visibleOk} placeholders still on screen after scrolling back`);
  await page.setViewportSize({ width: 1280, height: 800 });
});

// 9. back-to-top button
await test("back to top", async (res) => {
  await open("/images?sortby=path&sortdir=asc");
  await wheelToEnd();
  const shown = await page.evaluate(() => !document.querySelector(".isc-to-top").classList.contains("isc-hidden"));
  check(res, shown, "button not shown after scrolling");
  if (shown) { await page.click(".isc-to-top"); await sleep(1200); }
  const y = await page.evaluate(() => scrollY);
  check(res, y < 5, `not at top after click (y=${y})`);
});

// 10. narrow (phone-sized) window
await test("phone width", async (res) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await open("/scenes?sortby=title&sortdir=asc");
  const end = await wheelToEnd(150);
  res.data = { final: end.items, total: end.total };
  check(res, end.items === end.total, `loaded ${end.items} of ${end.total}`);
  const hdr = await headerCheck();
  res.data.header = hdr;
  check(res, hdr.onScreen, "toolbar scrolled away");
  await page.setViewportSize({ width: 1280, height: 800 });
});

// 11. settings: switching it off for Grid view gives normal pages back
await test("setting: disable in Grid view", async (res) => {
  await gql(`mutation { configurePlugin(plugin_id: "InfiniteScroll", input: { disableGrid: true }) }`);
  try {
    await open("/scenes?sortby=title&sortdir=asc");
    await sleep(1000);
    const s = await state();
    const pager = await page.evaluate(() => !!document.querySelector(".pagination-footer-container .pagination, .pagination-footer .pagination"));
    res.data = { active: s.active, footerPager: pager };
    check(res, !s.active, "still active with disableGrid on");
    check(res, pager, "Stash's normal page buttons missing");
  } finally {
    await gql(`mutation { configurePlugin(plugin_id: "InfiniteScroll", input: { disableGrid: false }) }`);
  }
});

// 12. hover previews still play inside the infinite list
await test("hover preview plays", async (res) => {
  await open("/scenes?sortby=title&sortdir=asc");
  await wheelToEnd();
  await page.evaluate(() => window.scrollTo(0, 900));
  await sleep(1200);
  const box = await page.evaluate(() => {
    const c = [...document.querySelectorAll(".scene-card")].find((x) => { const b = x.getBoundingClientRect(); return b.top > 200 && b.bottom < innerHeight; });
    const t = c && c.querySelector(".scene-card-preview, .thumbnail-section");
    const b = t && t.getBoundingClientRect();
    return b && { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  });
  check(res, !!box, "no card to hover");
  if (!box) return;
  await page.mouse.move(box.x, box.y);
  await sleep(2500);
  const v = await page.evaluate(({ x, y }) => {
    const el = document.elementFromPoint(x, y);
    const card = el && el.closest(".scene-card");
    const vid = card && card.querySelector("video");
    return vid ? { paused: vid.paused, t: vid.currentTime, src: !!vid.currentSrc } : null;
  }, box);
  res.data = v;
  check(res, v && !v.paused && v.t > 0, `preview not playing (${JSON.stringify(v)})`);
  await page.mouse.move(5, 5);
});

// 13. reloading mid-list comes back to the same place
await test("reload keeps position", async (res) => {
  await open("/scenes?sortby=title&sortdir=asc");
  await wheelToEnd();
  await page.evaluate(() => window.scrollTo(0, 2200));
  await sleep(1200);
  const before = await page.evaluate(() => {
    const card = [...document.querySelectorAll(".scene-card")].find((x) => { const b = x.getBoundingClientRect(); return b.top > 150; });
    const a = card.querySelector("a[href*='/scenes/']");
    return { href: a.getAttribute("href"), top: Math.round(document.querySelector(`.scene-card a[href="${a.getAttribute("href")}"]`).getBoundingClientRect().top), url: location.search };
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await sleep(3500);
  const after = await page.evaluate((h) => { const a = document.querySelector(`.scene-card a[href="${h}"]`); return { top: a ? Math.round(a.getBoundingClientRect().top) : null, url: location.search, earlier: !!document.querySelector(".isc-top button") }; }, before.href);
  res.data = { before, after };
  check(res, after.url === before.url, `address changed ${before.url} -> ${after.url}`);
  check(res, after.top !== null && Math.abs(after.top - before.top) < 60, `card moved ${before.top} -> ${after.top}`);
});

currentTest = "done";
await browser.close();
report.passed = report.results.filter((r) => r.ok).length;
report.failed = report.results.filter((r) => !r.ok).length;
const outDir = new URL("./.sandbox/", import.meta.url);
mkdirSync(outDir, { recursive: true });
writeFileSync(new URL(`report-${label}.json`, outDir), JSON.stringify(report, null, 2));
process.exitCode = report.failed ? 1 : 0;
console.log(`\n${label} (${report.version.version}): ${report.passed} passed, ${report.failed} failed, ${report.errors.length} console errors`);

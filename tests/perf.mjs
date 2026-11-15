// Measures how scrolling a list feels: scrolls at a steady pace the way a
// mouse wheel does and reports late frames, time spent waiting at the bottom
// and empty cards in view.
//
//   node perf.mjs <port> [path] [options as NAME=value in the environment]
//
//   PACE=6       rows of cards per second (the same experience at any zoom or card size)
//   SECS=15      how long to scroll
//   RUNS=3       repeats; each starts in a new browser profile (nothing cached)
//   CPU=1        slow the page's main thread by this factor (4 = a much slower PC)
//   DELAY=0      hold every picture and video back this many ms (a slow disk)
//   PROFILE=1    also say which scripts the time went to
//   TRACE=1      also say which kind of browser work it went to (script, layout, paint...)
//   MOUSE_Y=500  where the pointer rests while the wheel turns (20 = on the top bar, off the cards)
//   BROWSER_CHANNEL=msedge   another browser (default chrome)
//   LABEL=...    a name for the JSON line printed at the end
import { chromium } from "playwright-core";

const port = process.argv[2];
const path = process.argv[3] || "/scenes";
if (!port) { console.log("usage: node perf.mjs <port> [path]"); process.exit(1); }
const env = (k, d) => (process.env[k] === undefined || process.env[k] === "" ? d : Number(process.env[k]));
const PACE = env("PACE", 6), SECS = env("SECS", 15), RUNS = env("RUNS", 3), CPU = env("CPU", 1), DELAY = env("DELAY", 0), MY = env("MOUSE_Y", 500);
const base = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const channel = process.env.BROWSER_CHANNEL === undefined ? "chrome" : process.env.BROWSER_CHANNEL;
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };

async function run(i) {
  // a real GPU, as in a visible browser; headless would otherwise draw in software
  const browser = await chromium.launch({ ...(channel ? { channel } : {}), headless: true, args: ["--enable-gpu", "--use-angle=d3d11", "--ignore-gpu-blocklist", "--mute-audio"] });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 120)));
  if (DELAY) {
    await page.route(/\/(scene|image|performer|studio|tag|gallery|group)\/[^?]*\/(screenshot|thumbnail|image|preview|webp)|\/(performer|studio|tag|group)\/\d+\/image/, async (route) => { await sleep(DELAY); route.continue(); });
  }
  await page.goto(base + path, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".isc-list [data-isc-item], .isc-list .isc-cell, [data-isc-item]", { timeout: 30000 });
  await sleep(4000);
  await page.mouse.move(800, MY);
  const cdp = await ctx.newCDPSession(page);
  if (CPU > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU });
  const info = await page.evaluate(() => {
    const items = [...document.querySelectorAll("[data-isc-item]")];
    const tops = [...new Set(items.map((e) => Math.round(e.getBoundingClientRect().top)))].sort((a, b) => a - b);
    const gl = document.createElement("canvas").getContext("webgl");
    const dbg = gl && gl.getExtension("WEBGL_debug_renderer_info");
    return { row: tops.length > 1 ? tops[1] - tops[0] : 300, perRow: items.filter((e) => Math.round(e.getBoundingClientRect().top) === tops[0]).length,
      gpu: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : "none" };
  });
  const pxPerSec = PACE * info.row;
  // a wheel turns in notches of about 100 px; faster scrolling is more notches a second
  const TICK_MS = 50;
  const step = (pxPerSec * TICK_MS) / 1000;
  await page.evaluate(() => {
    const m = (window.__m = { gaps: [], long: [], blank: 0, noPic: 0, wait: 0, samples: 0, stop: false, y0: window.scrollY, t0: performance.now() });
    new PerformanceObserver((l) => { for (const e of l.getEntries()) m.long.push(e.duration); }).observe({ type: "longtask" });
    let last = performance.now();
    let lastCheck = 0;
    const f = () => {
      const now = performance.now();
      m.gaps.push(now - last);
      last = now;
      // sampled about 20 times a second, so measuring doesn't slow the page itself
      if (now - lastCheck > 50) {
        lastCheck = now;
        m.samples++;
        // an empty card (a placeholder not drawn yet) on screen
        const vh = window.innerHeight;
        for (const el of document.querySelectorAll(".isc-ph")) {
          const r = el.getBoundingClientRect();
          if (r.bottom > 80 && r.top < vh) { m.blank++; break; }
        }
        // a drawn card on screen whose picture hasn't arrived yet
        for (const img of document.querySelectorAll("[data-isc-item] img")) {
          if (img.complete && img.naturalWidth) continue;
          const r = img.getBoundingClientRect();
          if (r.height && r.bottom > 80 && r.top < vh) { m.noPic++; break; }
        }
        // at the very bottom with more still to load: waiting for a batch
        const se = document.scrollingElement;
        const end = document.querySelector(".isc-sentinel");
        if (se.scrollHeight - se.scrollTop - se.clientHeight < 4 && !(end && /^End of results/.test(end.textContent))) m.wait++;
      }
      if (!m.stop) requestAnimationFrame(f);
    };
    requestAnimationFrame(f);
  });
  if (process.env.PROFILE) {
    await cdp.send("Profiler.enable");
    await cdp.send("Profiler.setSamplingInterval", { interval: 250 });
    await cdp.send("Profiler.start");
  }
  if (process.env.TRACE) await browser.startTracing(page, { categories: ["devtools.timeline", "disabled-by-default-devtools.timeline"] });
  // Sent on the clock and not awaited: a hand keeps turning the wheel while the
  // page is busy, so a slow page must not slow the scrolling down.
  const t0 = Date.now();
  for (let n = 1; Date.now() - t0 < SECS * 1000; n++) {
    cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 800, y: MY, deltaX: 0, deltaY: step }).catch(() => {});
    const due = t0 + n * TICK_MS;
    if (due > Date.now()) await sleep(due - Date.now());
  }
  await sleep(500);
  let work = null;
  if (process.env.TRACE) {
    // what the page's main thread spent its time on, by kind of work (each
    // event's own time, without what it contains)
    const events = JSON.parse((await browser.stopTracing()).toString()).traceEvents.filter((e) => e.ph === "X" && e.dur);
    const busy = new Map();
    for (const e of events) busy.set(e.pid + ":" + e.tid, (busy.get(e.pid + ":" + e.tid) || 0) + (e.name === "FunctionCall" || e.name === "Layout" || e.name === "UpdateLayoutTree" ? e.dur : 0));
    const main = [...busy].sort((a, b) => b[1] - a[1])[0][0];
    const own = {};
    const calls = {};
    // the same, for the work inside frames' worth of tasks that ran long
    const ownLong = {};
    let longTasks = 0;
    const stack = [];
    for (const e of events.filter((x) => x.pid + ":" + x.tid === main).sort((a, b) => a.ts - b.ts || b.dur - a.dur)) {
      while (stack.length && stack[stack.length - 1].end <= e.ts) stack.pop();
      const inLong = stack.length ? stack[0].long : e.dur > 25000;
      if (!stack.length && inLong) longTasks++;
      if (stack.length) {
        own[stack[stack.length - 1].name] -= e.dur;
        if (inLong) ownLong[stack[stack.length - 1].name] -= e.dur;
      }
      own[e.name] = (own[e.name] || 0) + e.dur;
      if (inLong) ownLong[e.name] = (ownLong[e.name] || 0) + e.dur;
      calls[e.name] = (calls[e.name] || 0) + 1;
      stack.push({ name: e.name, end: e.ts + e.dur, long: inLong });
    }
    console.log(` in ${longTasks} tasks over 25 ms:`, Object.entries(ownLong).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => `${Math.round(v / 1000)} ${k}`).join(" | "));
    work = Object.entries(own).sort((a, b) => b[1] - a[1]).slice(0, 14).map(([k, v]) => `${Math.round(v / 1000)} ${k} x${calls[k]}`);
  }
  const m = await page.evaluate(() => {
    const m = window.__m;
    m.stop = true;
    const se = document.scrollingElement;
    const imgs = performance.getEntriesByType("resource").filter((e) => e.initiatorType === "img" && e.startTime > m.t0).map((e) => e.duration);
    // the plugin's own requests for more items: how long each took, and how
    // much of that was spent waiting for a free connection
    const gq = performance.getEntriesByType("resource").filter((e) => e.name.endsWith("/graphql") && e.startTime > m.t0);
    const mid = (a) => { const v = a.sort((x, y) => x - y); return v.length ? Math.round(v[Math.floor(v.length / 2)]) : 0; };
    const gql = { n: gq.length, total: mid(gq.map((e) => e.duration)), queued: mid(gq.map((e) => (e.requestStart || e.startTime) - e.startTime)), server: mid(gq.map((e) => e.responseStart - (e.requestStart || e.startTime))) };
    const dbg = window.InfiniteScrollDebug;
    const list = dbg ? [...dbg.activeLists][0] : null;
    return { gaps: m.gaps.slice(2), long: m.long, blank: m.blank, noPic: m.noPic, wait: m.wait, samples: m.samples, moved: window.scrollY - m.y0, ms: performance.now() - m.t0,
      atEnd: se.scrollHeight - se.scrollTop - se.clientHeight < 4, imgs, items: list ? list.itemCount : document.querySelectorAll("[data-isc-item]").length,
      crashed: /Something went wrong/i.test(document.body.innerText), gql };
  });
  let scripts = null;
  if (process.env.PROFILE) {
    const { profile } = await cdp.send("Profiler.stop");
    const byId = new Map(profile.nodes.map((n) => [n.id, n]));
    const parent = new Map();
    for (const n of profile.nodes) for (const c of n.children || []) parent.set(c, n.id);
    const name = (u) => (u.includes("/plugin/") ? "plugin:" + decodeURIComponent(u.split("/plugin/")[1].split("/")[0]) : u.includes("/assets/") ? "stash" : u ? "other" : null);
    const self = {}, incl = {}, inclFn = {};
    profile.samples.forEach((id, k) => {
      const n = byId.get(id);
      const d = (profile.timeDeltas[k] || 0) / 1000;
      const f = n.callFrame.functionName;
      let caller = null;
      for (let x = parent.get(id); x != null && !caller; x = parent.get(x)) caller = name(byId.get(x).callFrame.url);
      const key = name(n.callFrame.url) || (f === "(idle)" ? null : f.startsWith("(") ? f : `${f} < ${caller || "?"}`);
      if (key) self[key] = (self[key] || 0) + d;
      const seen = new Set();
      for (let x = id; x != null; x = parent.get(x)) { const p = name(byId.get(x).callFrame.url); if (p && p.startsWith("plugin:")) seen.add(p); }
      for (const p of seen) incl[p] = (incl[p] || 0) + d;
      // inclusive time per function of the plugin under test
      const fseen = new Set();
      for (let x = id; x != null; x = parent.get(x)) { const cf = byId.get(x).callFrame; if (cf.url.includes("/plugin/InfiniteScroll/")) fseen.add((cf.functionName || "(anon)") + ":" + (cf.lineNumber + 1)); }
      for (const k of fseen) inclFn[k] = (inclFn[k] || 0) + d;
    });
    const top = (o, n) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${Math.round(v)} ${k}`);
    scripts = { self: top(self, 14), inclusive: top(incl, 10), functions: top(inclFn, 22) };
  }
  await browser.close();
  const g = m.gaps;
  const total = g.reduce((a, x) => a + x, 0);
  const late = (ms) => g.filter((x) => x > ms).length;
  return {
    run: i, row: info.row, perRow: info.perRow, gpu: info.gpu.slice(0, 60),
    targetPxS: Math.round(pxPerSec), gotPxS: Math.round(m.moved / SECS),
    frames: g.length, fps: Math.round((g.length / total) * 1000),
    over33: late(33.4), over50: late(50), over100: late(100), worst: Math.round(Math.max(...g)),
    // ms the picture stood still beyond one normal frame, per second of scrolling
    stuckMsPerS: Math.round((g.filter((x) => x > 33.4).reduce((a, x) => a + x - 16.7, 0) / total) * 1000),
    blankPct: Math.round((m.blank / m.samples) * 100), noPicPct: Math.round((m.noPic / m.samples) * 100), waitPct: Math.round((m.wait / m.samples) * 100),
    longTasks: m.long.length, longMs: Math.round(m.long.reduce((a, x) => a + x, 0)),
    imgs: m.imgs.length, imgMed: Math.round(med(m.imgs)), imgP95: Math.round([...m.imgs].sort((a, b) => a - b)[Math.floor(m.imgs.length * 0.95)] || 0),
    gqlN: m.gql.n, gqlMs: m.gql.total, gqlQueuedMs: m.gql.queued, gqlServerMs: m.gql.server, items: m.items, atEnd: m.atEnd, crashed: m.crashed, errors: errors.length, scripts, work,
  };
}

const rows = [];
for (let i = 1; i <= RUNS; i++) {
  const r = await run(i);
  rows.push(r);
  const { scripts, work, ...flat } = r;
  if (work) console.log(" main thread ms:", work.join(" | "));
  console.log(JSON.stringify(flat));
  if (scripts) { console.log(" self ms:", scripts.self.join(" | ")); console.log(" inclusive ms:", scripts.inclusive.join(" | ")); console.log(" functions:\n  " + scripts.functions.join("\n  ")); }
}
const sum = (k) => { const v = rows.map((r) => r[k]); return `${med(v)} (${Math.min(...v)}-${Math.max(...v)})`; };
console.log(JSON.stringify({ label: process.env.LABEL || "", path, pace: PACE, cpu: CPU, delay: DELAY,
  gotPxS: sum("gotPxS"), fps: sum("fps"), over33: sum("over33"), over50: sum("over50"), over100: sum("over100"), worst: sum("worst"),
  stuckMsPerS: sum("stuckMsPerS"), blankPct: sum("blankPct"), noPicPct: sum("noPicPct"), waitPct: sum("waitPct"), longMs: sum("longMs"), imgMed: sum("imgMed"), imgP95: sum("imgP95"), gqlQueuedMs: sum("gqlQueuedMs"), items: sum("items") }));

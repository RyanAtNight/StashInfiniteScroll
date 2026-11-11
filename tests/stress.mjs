// Scroll stress: wheels up and down fast through long lists, hovering cards, and
// reports any page error or Stash's "Something went wrong" screen.
//   node stress.mjs <port> [rounds]
// INJECT=translate wraps card text in <font> like browser page translation does.
import { chromium } from "playwright-core";

const port = process.argv[2];
const rounds = Number(process.argv[3] || 6);
const base = `http://127.0.0.1:${port}`;
const channel = process.env.BROWSER_CHANNEL ?? "chrome";
const browser = await chromium.launch(channel ? { channel, headless: true } : { headless: true });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e.stack || e).slice(0, 800)));
page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text().slice(0, 800)); });
await page.addInitScript(() => document.addEventListener("play", (e) => { e.target.muted = true; }, true));
if (process.env.INJECT === "translate") {
  // what Chrome / Google Translate does: replace text nodes with <font> wrappers
  await page.addInitScript(() => {
    const wrap = (root) => {
      const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const nodes = [];
      while (w.nextNode()) if (w.currentNode.nodeValue.trim()) nodes.push(w.currentNode);
      for (const t of nodes) {
        if (!t.parentNode || t.parentNode.tagName === "FONT") continue;
        const f = document.createElement("font");
        f.textContent = t.nodeValue;
        t.parentNode.replaceChild(f, t);
      }
    };
    document.addEventListener("DOMContentLoaded", () =>
      new MutationObserver(() => document.querySelectorAll(".isc-list").forEach(wrap))
        .observe(document.body, { childList: true, subtree: true }));
  });
}
if (process.env.WHERE) {
  // log which node React failed to remove, and where it sits
  await page.addInitScript(() => {
    const desc = (n) => {
      const out = [];
      for (let e = n; e && e.nodeType === 1 || (e && out.length === 0); e = e.parentNode) {
        out.push(e.nodeType === 3 ? "#text(" + e.nodeValue.slice(0, 20) + ")" : e.tagName.toLowerCase() + (e.className && typeof e.className === "string" ? "." + e.className.split(" ").join(".") : ""));
        if (out.length > 7) break;
      }
      return out.join(" < ");
    };
    for (const k of ["removeChild", "insertBefore"]) {
      const o = Node.prototype[k];
      Node.prototype[k] = function (c, ref) {
        const target = k === "removeChild" ? c : ref;
        if (target && target.parentNode !== this) console.warn("MISMATCH", k, "parent:", desc(this), "| node:", desc(target), "| node's real parent:", target.parentNode ? desc(target.parentNode) : "none");
        return o.apply(this, arguments);
      };
    }
  });
  page.on("console", (m) => { if (m.text().startsWith("MISMATCH")) console.log(m.text().slice(0, 600)); });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const crashed = () => page.evaluate(() => /Something went wrong/i.test(document.body.innerText));

let rng = 12345;
const rand = () => ((rng = (rng * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

const paths = (process.env.PATHS || "/scenes,/performers,/performers/1/scenes,/scenes?disp=2,/images").split(",");
let bad = false;
for (const path of paths) {
  await page.goto(base + path, { waitUntil: "domcontentloaded" });
  await sleep(2500);
  await page.mouse.move(640, 500);
  let n = 0;
  for (let r = 0; r < rounds && !bad; r++) {
    // fling down, then jitter, then fling up
    for (let i = 0; i < 25; i++) { await page.mouse.wheel(0, 600 + rand() * 2400); await sleep(rand() * 60); n++; }
    for (let i = 0; i < 20; i++) {
      await page.mouse.wheel(0, (rand() - 0.5) * 3000);
      await page.mouse.move(100 + rand() * 1080, 150 + rand() * 600);
      await sleep(rand() * 120);
      n++;
    }
    for (let i = 0; i < 15; i++) { await page.mouse.wheel(0, -(600 + rand() * 2400)); await sleep(rand() * 60); n++; }
    if (await crashed()) bad = true;
  }
  const items = await page.evaluate(() => { const r = [...(window.InfiniteScrollDebug?.activeLists || [])][0]; return r ? r.itemCount : null; });
  console.log(`${bad ? "CRASH" : "ok   "} ${path} wheel-steps=${n} items=${items}`);
  if (bad) break;
}
for (const e of errors.slice(0, 8)) console.log("ERR", e);
await browser.close();
process.exit(bad || errors.some((e) => /removeChild|insertBefore/.test(e)) ? 1 : 0);

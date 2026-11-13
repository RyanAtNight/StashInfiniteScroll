// Checks Infinite Scroll next to other plugins that patch the same components.
// Installs small stand-in plugins into a running sandbox, one at a time, and
// removes them again at the end:
//   iscTestWrap   patches PerformerCard with "instead" and renders the rest of
//                 the chain as a component inside its own div, like Hover Cards
//                 does. It loads before Infinite Scroll (Stash loads plugins in
//                 reverse id order, and lowercase sorts after uppercase).
//   iscTestAfter  on SceneCard a "before" patch passing props alone and an
//                 "after" patch returning an array (the card plus a badge);
//                 on PerformerCard an "after" patch returning [] (no card).
//                 Also loads before Infinite Scroll.
//   iscTestLater  registers "instead" patches after Infinite Scroll, written
//                 the way Stash's docs show: (props, _, Original).
//   node neighbours.mjs <port>
import { chromium } from "playwright-core";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const port = process.argv[2];
const base = `http://127.0.0.1:${port}`;
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(process.env.SANDBOX_DIR || join(here, ".sandbox"));
let cfg;
for (const d of readdirSync(root).filter((x) => x.startsWith("cfg-"))) {
  if (readFileSync(join(root, d, "config.yml"), "utf8").includes(`port: ${port}\n`)) cfg = join(root, d);
}
if (!cfg) throw new Error("no sandbox on port " + port);
const pluginsDir = join(cfg, "plugins");

async function gql(query, variables) {
  const r = await fetch(`${base}/graphql`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query, variables }) });
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors));
  return j.data;
}

const STANDINS = {
  iscTestWrap: `(function () {
  const api = window.PluginApi, h = api.React.createElement;
  // these checks only mean something if this registers before Infinite Scroll
  (window.__iscTestFirst = window.__iscTestFirst || {})["iscTestWrap"] = !window.InfiniteScrollDebug;
  for (const n of ["PerformerCard", "SceneCard"]) {
    api.patch.instead(n, function (props, _, Original) {
      return h("div", { className: "isc-test-wrap" }, h(Original, props));
    });
  }
})();`,
  iscTestAfter: `(function () {
  const api = window.PluginApi, React = api.React, h = React.createElement;
  // these checks only mean something if this registers before Infinite Scroll
  (window.__iscTestFirst = window.__iscTestFirst || {})["iscTestAfter"] = !window.InfiniteScrollDebug;
  // a "before" patch that drops React's second argument
  api.patch.before("SceneCard", function (props) {
    return [props];
  });
  api.patch.after("SceneCard", function (props, result) {
    return [
      React.cloneElement(result, { key: "card" }),
      h("span", { key: "badge", className: "isc-test-badge", style: { position: "absolute" } }),
    ];
  });
  // hides every performer card
  api.patch.after("PerformerCard", function () {
    return [];
  });
})();`,
  iscTestLater: `(function () {
  const api = window.PluginApi, h = api.React.createElement;
  window.__iscTestLater = {};
  const go = () => {
    if (!window.InfiniteScrollDebug) return setTimeout(go, 20);
    for (const n of ["PerformerCard", "PerformerList", "Pagination", "PaginationIndex"]) {
      api.patch.instead(n, function (props, _, Original) {
        window.__iscTestLater[n] = typeof Original;
        return h(Original, props);
      });
    }
  };
  go();
})();`,
};

function install(id) {
  const dir = join(pluginsDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, id + ".yml"), `name: ${id}\nversion: 0.0.1\nui:\n  javascript:\n    - ${id}.js\n`);
  writeFileSync(join(dir, id + ".js"), STANDINS[id]);
}
function removeAll() {
  for (const id of Object.keys(STANDINS)) rmSync(join(pluginsDir, id), { recursive: true, force: true });
}

const browser = await chromium.launch(process.env.BROWSER_CHANNEL === "" ? { headless: true } : { channel: process.env.BROWSER_CHANNEL || "chrome", headless: true });
let failed = 0;
const result = (ok, name, detail) => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " (" + detail + ")" : ""}`);
};

async function open(path, { wrapCards, ready = ".isc-list [data-isc-item]" } = {}) {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 300)));
  if (wrapCards) {
    // another script wrapping each performer card root in its own element
    await page.addInitScript(() => {
      document.addEventListener("DOMContentLoaded", () =>
        new MutationObserver(() => {
          document.querySelectorAll(".performer-card:not([data-isc-test])").forEach((card) => {
            card.dataset.iscTest = "1";
            const w = document.createElement("div");
            w.className = "foreign-wrapper";
            card.parentNode.insertBefore(w, card);
            w.appendChild(card);
          });
        }).observe(document.body, { childList: true, subtree: true }));
    });
  }
  await page.goto(base + path, { waitUntil: "domcontentloaded" });
  // the first page after a plugin reload can take a while
  await page.waitForFunction((sel) => document.querySelector(sel) || /Something went wrong/i.test(document.body.innerText), ready, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1500);
  await page.evaluate(() => {
    const m = document.querySelector(".modal.show");
    const b = m && [...m.querySelectorAll("button")].find((x) => /close|ok|dismiss|got it/i.test(x.textContent));
    if (b) b.click();
  });
  await page.waitForTimeout(800);
  return {
    page,
    errors,
    crashed: () => page.evaluate(() => /Something went wrong/i.test(document.body.innerText)),
    firstFor: (id) => page.evaluate((id) => !!(window.__iscTestFirst && window.__iscTestFirst[id]), id),
  };
}

try {
  removeAll();

  // --- a plugin that renders the rest of the card's patch chain as a component
  install("iscTestWrap");
  await gql("mutation { reloadPlugins }");
  {
    const { page, errors, crashed, firstFor } = await open("/performers");
    const order = await firstFor("iscTestWrap");
    const n = await page.evaluate(() => {
      window.__iscCards = [...document.querySelectorAll(".performer-card")];
      return window.__iscCards.length;
    });
    await page.mouse.move(640, 400);
    for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, 300); await page.waitForTimeout(700); }
    await page.waitForTimeout(2000);
    const r = await page.evaluate(() => ({
      now: document.querySelectorAll(".performer-card").length,
      kept: window.__iscCards.filter((c) => c.isConnected).length,
    }));
    const bad = await crashed();
    result(order && !bad && n > 0 && r.now > n && r.kept === n, "cards already shown survive a new batch next to a wrapping plugin", `${order ? "" : "stand-in loaded after Infinite Scroll, "}${r.kept}/${n} kept, ${r.now} now${bad ? ", crashed" : ""}${errors.length ? ", " + errors[0] : ""}`);
    await page.context().close();
  }
  {
    // far-off cards become placeholders of the right size and come back,
    // although each card now sits inside the other plugin's element
    const { page, errors, crashed } = await open("/scenes");
    const first = () => page.evaluate(() => {
      const el = document.querySelector(".isc-list [data-isc-item]");
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { ph: el.classList.contains("isc-ph"), h: Math.round(r.height), w: Math.round(r.width), wrapped: !!el.closest(".isc-test-wrap") || el.classList.contains("isc-test-wrap") };
    });
    const before = await first();
    await page.mouse.move(640, 400);
    for (let i = 0; i < 40; i++) { await page.mouse.wheel(0, 1500); await page.waitForTimeout(150); }
    await page.waitForTimeout(1500);
    const far = await first();
    const phs = await page.evaluate(() => document.querySelectorAll(".isc-ph").length);
    for (let i = 0; i < 40; i++) { await page.mouse.wheel(0, -1500); await page.waitForTimeout(150); }
    await page.waitForTimeout(2000);
    const back = await first();
    const bad = await crashed();
    const ok = !bad && before && before.wrapped && !before.ph && far && far.ph && phs > 0 &&
      Math.abs(far.h - before.h) <= 2 && Math.abs(far.w - before.w) <= 2 && back && !back.ph && back.wrapped;
    result(ok, "wrapped cards turn into same-size placeholders and back", `${phs} placeholders, card ${before && before.w}x${before && before.h}, placeholder ${far && far.w}x${far && far.h}${far && !far.ph ? " (not a placeholder)" : ""}${back && back.ph ? ", not restored" : ""}${bad ? ", crashed" : ""}${errors.length ? ", " + errors[0] : ""}`);
    await page.context().close();
  }
  {
    // the image page shows a PerformerCard for each performer, outside any list
    const img = (await gql(`{ findImages(image_filter: { performer_count: { value: 0, modifier: GREATER_THAN } }, filter: { per_page: 1 }) { images { id title } } }`)).findImages.images[0];
    // the reported crash needed an image that already has a title
    const newTitle = "Renamed " + Date.now();
    await gql(`mutation($id: ID!) { imageUpdate(input: { id: $id, title: "Has a title" }) { id } }`, { id: img.id });
    try {
    const { page, errors, crashed } = await open(`/images/${img.id}`, { wrapCards: true, ready: ".image-tabs" });
    await page.waitForSelector(".performer-card", { timeout: 10000 }).catch(() => {});
    const card = await page.evaluate(() => { window.__iscCard = document.querySelector(".performer-card"); return !!window.__iscCard; });
    // what the user did: open Edit, change the title, save, then back to Details
    const steps = [];
    const step = async (name, fn) => {
      if (await crashed()) return;
      try { await fn(); steps.push(name); } catch (e) { steps.push(name + " failed: " + String(e.message).split("\n")[0]); }
      await page.waitForTimeout(800);
    };
    await step("edit tab", async () => {
      await page.locator('a[data-rb-event-key="image-edit-panel"]').first().click({ timeout: 5000 });
      await page.locator("#title").first().waitFor({ state: "visible", timeout: 5000 });
    });
    await step("rename and save", async () => {
      await page.locator("#title").first().fill(newTitle);
      await page.locator("button.edit-button, .edit-buttons button.btn-primary").first().click({ timeout: 5000 });
    });
    await step("details tab", async () => {
      await page.locator('a[data-rb-event-key="image-details-panel"]').first().click({ timeout: 5000 });
      await page.locator(".image-performers .performer-card").first().waitFor({ state: "visible", timeout: 5000 });
    });
    const bad = await crashed();
    const kept = await page.evaluate(() => !!window.__iscCard && window.__iscCard.isConnected);
    const allSteps = steps.length === 3 && steps.every((s) => !s.includes("failed"));
    const saved = (await gql(`query($id: ID!) { findImage(id: $id) { title } }`, { id: img.id })).findImage.title === newTitle;
    result(card && !bad && kept && allSteps && saved, "image page with a wrapped performer card survives editing and saving the title", `${bad ? "crashed" : kept ? "card kept" : card ? "card rebuilt" : "no card"}; ${steps.join(", ")}; ${saved ? "title saved" : "title not saved"}${errors.length ? "; " + errors[0] : ""}`);
    await page.context().close();
    } finally {
      await gql(`mutation($id: ID!, $t: String) { imageUpdate(input: { id: $id, title: $t }) { id } }`, { id: img.id, t: img.title });
    }
  }
  removeAll();

  // --- a plugin whose "after" patch returns an array
  install("iscTestAfter");
  await gql("mutation { reloadPlugins }");
  {
    const { page, errors, crashed, firstFor } = await open("/scenes");
    const order = await firstFor("iscTestAfter");
    // the first item of the list, followed card -> placeholder -> card
    const state = () => page.evaluate(() => {
      const item = document.querySelector(".isc-list [data-isc-item]");
      const cell = item && item.closest(".isc-cell");
      return {
        first: !item ? "none" : item.classList.contains("isc-ph") ? "placeholder"
          : item.classList.contains("scene-card") && cell && cell.querySelector(":scope > .isc-test-badge") ? "card+badge" : "card without badge",
        cards: document.querySelectorAll(".isc-list .scene-card").length,
        badges: document.querySelectorAll(".isc-list .isc-test-badge").length,
      };
    });
    const first = await state();
    await page.mouse.move(640, 400);
    for (let i = 0; i < 40; i++) { await page.mouse.wheel(0, 1500); await page.waitForTimeout(150); }
    await page.waitForTimeout(1500);
    const far = await state();
    for (let i = 0; i < 40; i++) { await page.mouse.wheel(0, -1500); await page.waitForTimeout(150); }
    await page.waitForTimeout(2000);
    const back = await state();
    const bad = await crashed();
    const ok = order && !bad && first.first === "card+badge" && far.first === "placeholder" && back.first === "card+badge" &&
      [first, far, back].every((c) => c.badges === c.cards);
    result(ok, "another plugin's array result (after a before patch with one argument) survives placeholders", `${order ? "" : "stand-in loaded after Infinite Scroll; "}first item ${first.first} -> ${far.first} -> ${back.first}; cards/badges ${first.cards}/${first.badges}, ${far.cards}/${far.badges}, ${back.cards}/${back.badges}${bad ? ", crashed" : ""}${errors.length ? ", " + errors[0] : ""}`);
    await page.context().close();
  }
  {
    // an empty array from another plugin's after patch: no card, no crash
    const { page, errors, crashed } = await open("/performers", { ready: ".isc-list .isc-ph, .isc-list [data-isc-item], .isc-list ~ *, .paginationIndex" });
    const r = await page.evaluate(() => ({ cards: document.querySelectorAll(".performer-card").length, list: !!document.querySelector(".isc-list") }));
    const bad = await crashed();
    result(!bad && r.list && r.cards === 0 && !errors.length, "another plugin's after patch returning an empty array hides the card without a crash", `${r.cards} cards${bad ? ", crashed" : ""}${errors.length ? ", " + errors[0] : ""}`);
    await page.context().close();
  }
  removeAll();

  // --- a plugin that patches after Infinite Scroll, written as in Stash's docs
  install("iscTestLater");
  await gql("mutation { reloadPlugins }");
  {
    // (Infinite Scroll patches cards with "after", so only the list and
    // pagination patches really test this; the card one is a control)
    const { page, errors, crashed } = await open("/performers");
    const seen = await page.evaluate(() => window.__iscTestLater || {});
    const cards = await page.evaluate(() => document.querySelectorAll(".performer-card").length);
    // and infinite loading still works with the list rendered by that plugin
    await page.mouse.move(640, 400);
    for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, 600); await page.waitForTimeout(600); }
    await page.waitForTimeout(1500);
    const more = await page.evaluate(() => document.querySelectorAll(".performer-card").length);
    const bad = await crashed();
    // PaginationIndex only reaches the next patch while the list is loading,
    // so it's reported but not required
    const allFns = ["PerformerCard", "PerformerList", "Pagination"].every((n) => seen[n] === "function") && seen.PaginationIndex !== "undefined";
    result(!bad && cards > 0 && more > cards && allFns, "a plugin patching after Infinite Scroll gets its next function, and loading continues", `${bad ? "crashed, " : ""}${cards} -> ${more} cards, ${JSON.stringify(seen)}${errors.length ? ", " + errors[0] : ""}`);
    await page.context().close();
  }
} finally {
  removeAll();
  await gql("mutation { reloadPlugins }").catch(() => {});
  await browser.close();
}
process.exit(failed ? 1 : 0);

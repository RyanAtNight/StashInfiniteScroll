// Checks Infinite Scroll next to other plugins that patch the same components.
// Installs two small stand-in plugins into a running sandbox, one at a time,
// and removes them again at the end:
//   iscTestWrap   patches PerformerCard with "instead" and renders the rest of
//                 the chain as a component inside its own div, like Hover Cards
//                 does. It loads before Infinite Scroll (Stash loads plugins in
//                 reverse id order, and lowercase sorts after uppercase).
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
  api.patch.instead("PerformerCard", function (props, _, Original) {
    return h("div", { className: "isc-test-wrap" }, h(Original, props));
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

async function open(path, { wrapCards } = {}) {
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
  await page.waitForTimeout(2500);
  await page.evaluate(() => {
    const m = document.querySelector(".modal.show");
    const b = m && [...m.querySelectorAll("button")].find((x) => /close|ok|dismiss|got it/i.test(x.textContent));
    if (b) b.click();
  });
  await page.waitForTimeout(800);
  return { page, errors, crashed: () => page.evaluate(() => /Something went wrong/i.test(document.body.innerText)) };
}

try {
  removeAll();

  // --- a plugin that renders the rest of the card's patch chain as a component
  install("iscTestWrap");
  await gql("mutation { reloadPlugins }");
  {
    const { page, errors, crashed } = await open("/performers");
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
    result(!bad && n > 0 && r.now > n && r.kept === n, "cards already shown survive a new batch next to a wrapping plugin", `${r.kept}/${n} kept, ${r.now} now${bad ? ", crashed" : ""}${errors.length ? ", " + errors[0] : ""}`);
    await page.context().close();
  }
  {
    // the image page shows a PerformerCard for each performer, outside any list
    const img = (await gql(`{ findImages(image_filter: { performer_count: { value: 0, modifier: GREATER_THAN } }, filter: { per_page: 1 }) { images { id } } }`)).findImages.images[0];
    const { page, errors, crashed } = await open(`/images/${img.id}`, { wrapCards: true });
    await page.waitForSelector(".performer-card", { timeout: 10000 }).catch(() => {});
    const card = await page.evaluate(() => { window.__iscCard = document.querySelector(".performer-card"); return !!window.__iscCard; });
    await page.locator('a[data-rb-event-key="image-edit-panel"]').first().click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(800);
    await page.locator('a[data-rb-event-key="image-details-panel"]').first().click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(800);
    const bad = await crashed();
    const kept = await page.evaluate(() => !!window.__iscCard && window.__iscCard.isConnected);
    result(card && !bad && kept, "image page with a wrapped performer card survives switching tabs", `${bad ? "crashed" : kept ? "card kept" : card ? "card rebuilt" : "no card"}${errors.length ? ", " + errors[0] : ""}`);
    await page.context().close();
  }
  removeAll();

  // --- a plugin that patches after Infinite Scroll, written as in Stash's docs
  install("iscTestLater");
  await gql("mutation { reloadPlugins }");
  {
    const { page, errors, crashed } = await open("/performers");
    const bad = await crashed();
    const seen = await page.evaluate(() => window.__iscTestLater || {});
    const cards = await page.evaluate(() => document.querySelectorAll(".performer-card").length);
    const allFns = ["PerformerCard", "PerformerList", "Pagination", "PaginationIndex"].every((n) => seen[n] === "function");
    result(!bad && cards > 0 && allFns, "a plugin patching after Infinite Scroll gets its next function", `${bad ? "crashed, " : ""}${cards} cards, ${JSON.stringify(seen)}${errors.length ? ", " + errors[0] : ""}`);
    await page.context().close();
  }
} finally {
  removeAll();
  await gql("mutation { reloadPlugins }").catch(() => {});
  await browser.close();
}
process.exit(failed ? 1 : 0);

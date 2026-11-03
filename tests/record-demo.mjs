// Records the README demo: the scene Wall in a sandbox Stash filled by
// make-demo-media.mjs, scrolled at an easy pace to the end and back to top.
//   node record-demo.mjs <port> [outdir]
// Writes demo.avif, demo.gif and demo.mp4 to outdir (default .sandbox/demo). Headless; ffmpeg runs hidden.
import { chromium } from "playwright-core";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const port = process.argv[2];
if (!port) throw new Error("usage: node record-demo.mjs <port> [outdir]");
const outDir = resolve(process.argv[3] || join(here, ".sandbox", "demo"));
const frames = join(outDir, "frames");
const ffmpeg = process.env.FFMPEG || "ffmpeg";
const W = 1280, H = 720;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// titles from the file names ("001 Big Buck Bunny 01.mp4" -> "Big Buck Bunny 01")
async function gql(query, variables = {}) {
  const r = await fetch(`http://127.0.0.1:${port}/graphql`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query, variables }) });
  return (await r.json()).data;
}
for (const s of (await gql("{ findScenes(filter: { per_page: -1 }) { scenes { id title files { basename } } } }")).findScenes.scenes) {
  const t = s.files[0].basename.replace(/^\d+ /, "").replace(/\.mp4$/, "");
  if (s.title !== t) await gql("mutation($id: ID!, $t: String) { sceneUpdate(input: { id: $id, title: $t }) { id } }", { id: s.id, t });
}
// no filler "Performer 1 & Performer 2" lines under the titles
const ids = (await gql("{ findScenes(filter: { per_page: -1 }) { scenes { id } } }")).findScenes.scenes.map((s) => s.id);
await gql("mutation($ids: [ID!]) { bulkSceneUpdate(input: { ids: $ids, performer_ids: { ids: [], mode: SET } }) { id } }", { ids });

rmSync(frames, { recursive: true, force: true });
mkdirSync(frames, { recursive: true });

const channel = process.env.BROWSER_CHANNEL ?? "chrome";
const browser = await chromium.launch({ ...(channel ? { channel } : {}), headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
const page = await (await browser.newContext({ viewport: { width: W, height: H } })).newPage();
await page.goto(`http://127.0.0.1:${port}/scenes?disp=2&sortby=path&sortdir=asc`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => document.querySelectorAll(".wall-item").length >= 14, null, { timeout: 30000 });
// Stash's release-notes dialog on a fresh install
for (let i = 0; i < 3; i++) {
  await sleep(800);
  const closed = await page.evaluate(() => {
    const b = [...document.querySelectorAll(".modal.show button")].find((x) => /close|ok|dismiss|got it/i.test(x.textContent));
    if (b) b.click();
    return !!b;
  });
  if (!closed) break;
}
await page.mouse.move(W - 4, H / 2);
await sleep(3000); // let the first previews load and start

// capture continuously while the script scrolls; frame times drive the GIF timing
const shots = [];
let recording = true;
const capture = (async () => {
  while (recording) {
    const t = Date.now();
    const file = join(frames, `${String(shots.length).padStart(5, "0")}.jpg`);
    await page.screenshot({ path: file, type: "jpeg", quality: 85 });
    shots.push({ file, t });
  }
})();

async function scrollFor(ms, pxPerSec) {
  const step = 40, end = Date.now() + ms;
  while (Date.now() < end) { await page.mouse.wheel(0, (pxPerSec * step) / 1000); await sleep(step); }
}
const atEnd = () => page.evaluate(() => /End of results/.test(document.querySelector(".isc-sentinel")?.textContent || ""));

await sleep(1800);
// under one screen a second, so every preview keeps playing
const pace = Number(process.env.PACE || 620);
for (let i = 0; i < 20 && !(await atEnd()); i++) {
  await scrollFor(2000, pace);
  await sleep(350);
}
await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
await sleep(2000);
await page.click(".isc-to-top");
await sleep(2200);
recording = false;
await capture;
await browser.close();

// concat list with each frame's real duration
const lines = ["ffconcat version 1.0"];
for (let i = 0; i < shots.length; i++) {
  const d = ((shots[i + 1]?.t ?? shots[i].t + 80) - shots[i].t) / 1000;
  lines.push(`file '${shots[i].file.replace(/\\/g, "/")}'`, `duration ${d.toFixed(3)}`);
}
lines.push(`file '${shots.at(-1).file.replace(/\\/g, "/")}'`);
const list = join(frames, "list.txt");
writeFileSync(list, lines.join("\n"));
const run = (args) => execFileSync(ffmpeg, ["-v", "error", "-y", ...args], { windowsHide: true, stdio: "inherit" });
// film footage makes big GIFs: these defaults keep it under GitHub's 10 MB, played 1.4x faster
const gifW = Number(process.env.GIF_WIDTH || 560), fps = Number(process.env.GIF_FPS || 8), colors = Number(process.env.GIF_COLORS || 64), speed = Number(process.env.GIF_SPEED || 1.4);
run(["-f", "concat", "-safe", "0", "-i", list, "-vf", `setpts=PTS/${speed},fps=${fps},scale=${gifW}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=${colors}:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle`, join(outDir, "demo.gif")]);
// animated AVIF: about 1.3 MB for the same clip at 800 px and 12 fps, so the README loads fast;
// the GIF stays as the fallback for browsers without animated AVIF
run(["-f", "concat", "-safe", "0", "-i", list, "-vf", `setpts=PTS/${speed},fps=12,scale=800:-2:flags=lanczos,format=yuv420p`,
  "-c:v", "libsvtav1", "-crf", "44", "-preset", "5", "-f", "avif", "-loop", "0", join(outDir, "demo.avif")]);
run(["-f", "concat", "-safe", "0", "-i", list, "-vf", "fps=30,scale=960:-2,format=yuv420p", "-c:v", "libx264", "-crf", "28", "-preset", "slow", "-movflags", "+faststart", join(outDir, "demo.mp4")]);
console.log(`${shots.length} frames over ${((shots.at(-1).t - shots[0].t) / 1000).toFixed(1)} s -> ${outDir}`);

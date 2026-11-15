// A bigger sandbox Stash for measuring how scrolling feels (see perf.mjs).
//
//   node perf-lab.mjs media <clips folder> <media folder>   build the media (once)
//   node perf-lab.mjs start <name> <port> <media folder>    create (first time) and run a Stash on it
//   node perf-lab.mjs plugins <port> install <list.json>    install other plugins from their sources
//   node perf-lab.mjs plugins <port> on|off <list.json>     switch those plugins on or off
//
// <clips folder> holds short real videos (tests/README.md, "Demo recording"). Each
// becomes three scenes and four photo-sized images, so lists are long enough to
// scroll for a while. Everything else lives in tests/.sandbox/perf-<name>.
// GENERATED=<folder> puts Stash's generated files somewhere else (another disk).
import { spawn, execFileSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(process.env.SANDBOX_DIR || join(here, ".sandbox"));
const VERSION = process.env.STASH_VERSION || "v0.32.0";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const which = (name, envVar) => process.env[envVar] ||
  execFileSync(process.platform === "win32" ? "where" : "which", [name], { encoding: "utf8", windowsHide: true }).split(/\r?\n/)[0].trim();

function gqlFor(port) {
  return async (query, variables = {}) => {
    const r = await fetch(`http://127.0.0.1:${port}/graphql`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query, variables }) });
    const j = await r.json();
    if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 600));
    return j.data;
  };
}
async function waitJobs(gql) {
  for (;;) {
    const d = await gql("{ jobQueue { id status } }");
    if (!d.jobQueue || d.jobQueue.length === 0) return;
    await sleep(1500);
  }
}

// run up to n ffmpeg jobs at once
async function pool(jobs, n = 8) {
  const ffmpeg = which("ffmpeg", "FFMPEG");
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < jobs.length) {
      const args = jobs[i++];
      await new Promise((res, rej) => {
        const c = spawn(ffmpeg, ["-v", "error", "-y", ...args], { windowsHide: true, stdio: "ignore" });
        c.on("exit", (code) => (code === 0 ? res() : rej(new Error("ffmpeg failed: " + args.join(" ")))));
      });
    }
  }));
}

async function media(clips, out) {
  if (!clips || !out) throw new Error("usage: node perf-lab.mjs media <clips folder> <media folder>");
  const files = readdirSync(clips).filter((f) => /\.mp4$/i.test(f)).sort();
  if (!files.length) throw new Error("no .mp4 files in " + clips);
  for (const d of ["videos", "images", "portraits"]) mkdirSync(join(out, d), { recursive: true });
  const jobs = [];
  for (const f of files) {
    const base = f.replace(/\.mp4$/i, "");
    const src = join(clips, f);
    copyFileSync(src, join(out, "videos", f));
    // the same clip again as a different file, so Stash sees a different scene
    for (const v of [2, 3]) jobs.push(["-i", src, "-c", "copy", "-metadata", `comment=copy ${v}`, join(out, "videos", `${base} v${v}.mp4`)]);
    // photo-sized stills (a few MB each, like a camera's), so reading them costs what a real library costs
    for (const [k, t] of [1, 3, 5, 7].entries()) {
      jobs.push(["-ss", String(t), "-i", src, "-frames:v", "1", "-vf", "scale=3840:2160:flags=lanczos,noise=alls=14:allf=t", "-q:v", "2", join(out, "images", `${base} ${k + 1}.jpg`)]);
    }
    // a portrait crop for performer pictures
    jobs.push(["-ss", "4", "-i", src, "-frames:v", "1", "-vf", "crop=ih*2/3:ih,scale=800:1200:flags=lanczos", "-q:v", "3", join(out, "portraits", `${base}.jpg`)]);
  }
  await pool(jobs);
  writeFileSync(join(out, "done"), "");
  console.log(`media ready in ${out}: ${files.length * 3} videos, ${files.length * 4} images`);
}

async function populate(port, mediaDir) {
  const gql = gqlFor(port);
  // no release-notes dialog over the list
  await gql(`mutation { configureUISetting(key: "lastNoteSeen", value: 20991231) }`);
  await gql(`mutation { metadataScan(input: { scanGenerateCovers: true, scanGenerateThumbnails: ${process.env.NO_THUMBS ? "false" : "true"} }) }`);
  await waitJobs(gql);
  const ids = async (q, k) => (await gql(`{ ${q}(filter: { per_page: -1, sort: "path", direction: ASC }) { ${k} { id } } }`))[q][k].map((x) => x.id);
  const scenes = await ids("findScenes", "scenes");
  const images = await ids("findImages", "images");
  console.log(`scanned ${scenes.length} scenes, ${images.length} images`);
  const portraits = readdirSync(join(mediaDir, "portraits")).filter((f) => /\.jpg$/.test(f)).sort()
    .map((f) => "data:image/jpeg;base64," + readFileSync(join(mediaDir, "portraits", f)).toString("base64"));
  const pic = (i) => portraits[i % portraits.length];
  const tags = [], studios = [], performers = [];
  for (let i = 1; i <= 150; i++) tags.push((await gql(`mutation($n: String!) { tagCreate(input: { name: $n }) { id } }`, { n: `Tag ${i}` })).tagCreate.id);
  for (let i = 1; i <= 60; i++) {
    studios.push((await gql(`mutation($n: String!, $img: String) { studioCreate(input: { name: $n, image: $img }) { id } }`, { n: `Studio ${i}`, img: pic(i * 7) })).studioCreate.id);
  }
  const countries = ["US", "DE", "FR", "JP", "BR", "GB", "CA", "ES"];
  for (let i = 1; i <= 600; i++) {
    const v = { n: `Performer ${i}`, img: pic(i), t: [tags[i % 150], tags[(i * 7) % 150], tags[(i * 13) % 150]], c: countries[i % 8], b: `19${70 + (i % 30)}-0${1 + (i % 9)}-1${i % 9}`, f: i % 5 === 0, r: (i * 17) % 101 };
    performers.push((await gql(`mutation($n: String!, $img: String, $t: [ID!], $c: String, $b: String, $f: Boolean, $r: Int) { performerCreate(input: { name: $n, image: $img, tag_ids: $t, country: $c, birthdate: $b, favorite: $f, rating100: $r, gender: FEMALE }) { id } }`, v)).performerCreate.id);
  }
  for (let i = 0; i < scenes.length; i++) {
    await gql(`mutation($id: ID!, $p: [ID!], $t: [ID!], $s: ID, $r: Int) { sceneUpdate(input: { id: $id, performer_ids: $p, tag_ids: $t, studio_id: $s, rating100: $r, date: "2024-0${1 + (i % 9)}-1${i % 9}" }) { id } }`,
      { id: scenes[i], p: [performers[i % 600], performers[(i * 7 + 3) % 600]], t: [0, 1, 2, 3, 4].map((k) => tags[(i * (k + 3) + k) % 150]), s: studios[i % 60], r: (i * 13) % 101 });
  }
  for (let i = 0; i < images.length; i += 50) {
    const part = images.slice(i, i + 50);
    await gql(`mutation($ids: [ID!], $p: [ID!], $t: [ID!], $s: ID) { bulkImageUpdate(input: { ids: $ids, studio_id: $s, performer_ids: { ids: $p, mode: ADD }, tag_ids: { ids: $t, mode: ADD } }) { id } }`,
      { ids: part, p: [performers[(i / 50) % 600]], t: [tags[(i / 50) % 150], tags[(i / 50 + 9) % 150]], s: studios[(i / 50) % 60] });
  }
  if (!process.env.NO_PREVIEWS) {
    await gql(`mutation { metadataGenerate(input: { previews: true, sprites: false, markers: false }) }`);
    await waitJobs(gql);
  }
  console.log("populated", JSON.stringify(await gql("{ findScenes { count } findImages { count } findPerformers { count } findStudios { count } findTags { count } }")));
}

async function start(name, port, mediaDir) {
  if (!name || !port || !mediaDir) throw new Error("usage: node perf-lab.mjs start <name> <port> <media folder>");
  mediaDir = resolve(mediaDir);
  if (!existsSync(join(mediaDir, "done"))) throw new Error("build the media first: node perf-lab.mjs media <clips> " + mediaDir);
  const exe = join(root, "bin", VERSION, { win32: "stash-win.exe", linux: "stash-linux", darwin: "stash-macos" }[process.platform]);
  if (!existsSync(exe)) throw new Error(`no Stash ${VERSION} yet; run "node sandbox.mjs start ${VERSION} <port>" once to download it`);
  const cfg = join(root, `perf-${name}`);
  const fresh = !existsSync(join(cfg, "config.yml"));
  const p = (x) => x.replace(/\\/g, "/");
  if (fresh) {
    const generated = resolve(process.env.GENERATED || join(cfg, "generated"));
    for (const d of [generated, join(cfg, "cache"), join(cfg, "blobs"), join(cfg, "plugins"), join(cfg, "scrapers")]) mkdirSync(d, { recursive: true });
    writeFileSync(join(cfg, "config.yml"), [
      "stash:",
      `  - path: ${p(join(mediaDir, "videos"))}`,
      `  - path: ${p(join(mediaDir, "images"))}`,
      `database: ${p(join(cfg, "stash-go.sqlite"))}`,
      `generated: ${p(generated)}`,
      `cache: ${p(join(cfg, "cache"))}`,
      `blobs_path: ${p(join(cfg, "blobs"))}`,
      "blobs_storage: FILESYSTEM",
      `plugins_path: ${p(join(cfg, "plugins"))}`,
      `scrapers_path: ${p(join(cfg, "scrapers"))}`,
      "host: 127.0.0.1",
      `port: ${port}`,
      "parallel_tasks: 8",
      "nobrowser: true",
      `ffmpeg_path: ${p(which("ffmpeg", "FFMPEG"))}`,
      `ffprobe_path: ${p(which("ffprobe", "FFPROBE"))}`,
      "",
    ].join("\n"));
  }
  const dest = join(cfg, "plugins", "InfiniteScroll");
  rmSync(dest, { recursive: true, force: true });
  cpSync(resolve(here, "..", "InfiniteScroll"), dest, { recursive: true });
  const child = spawn(exe, ["--config", join(cfg, "config.yml"), "--nobrowser"], { cwd: cfg, stdio: "ignore", windowsHide: true });
  const end = () => { try { child.kill(); } catch (e) { /* gone */ } };
  process.on("SIGINT", () => { end(); process.exit(130); });
  process.on("SIGTERM", () => { end(); process.exit(143); });
  process.on("exit", end);
  const gql = gqlFor(port);
  for (let i = 0; ; i++) {
    try {
      const d = await gql("{ systemStatus { status } version { version } }");
      if (d.systemStatus.status === "OK") { console.log(`started ${d.version.version} on http://127.0.0.1:${port}`); break; }
    } catch (e) {
      if (i > 60) throw new Error("Stash didn't start");
    }
    await sleep(1000);
  }
  if (fresh) await populate(port, mediaDir);
  console.log("running; press Ctrl+C to stop it");
  setInterval(() => {}, 1 << 30);
}

// list.json: [{ "id": "...", "source": "https://.../index.yml" }, ...]
async function plugins(port, action, listFile) {
  const gql = gqlFor(port);
  const list = JSON.parse(readFileSync(listFile, "utf8"));
  if (action === "install") {
    for (const { id, source } of list) {
      try {
        await gql(`mutation($p: [PackageSpecInput!]!) { installPackages(type: Plugin, packages: $p) }`, { p: [{ id, sourceURL: source }] });
        await waitJobs(gql);
      } catch (e) {
        console.log("FAILED", id, String(e).slice(0, 200));
      }
    }
    await gql("mutation { reloadPlugins }");
  } else if (action === "on" || action === "off") {
    const have = (await gql("{ plugins { id } }")).plugins.map((x) => x.id);
    const map = {};
    for (const id of have) if (id !== "InfiniteScroll") map[id] = action === "on";
    await gql(`mutation($m: BoolMap!) { setPluginsEnabled(enabledMap: $m) }`, { m: map });
  }
  const now = (await gql("{ plugins { id name enabled } }")).plugins;
  console.log(now.map((x) => `${x.enabled ? "on " : "off"} ${x.id}`).join("\n"));
  console.log(`${now.filter((x) => x.enabled).length} of ${now.length} on`);
}

const [cmd, a, b, c] = process.argv.slice(2);
if (cmd === "media") await media(a, b);
else if (cmd === "start") await start(a, b, c);
else if (cmd === "plugins") await plugins(a, b, c);
else console.log("usage: node perf-lab.mjs media <clips> <media> | start <name> <port> <media> | plugins <port> install|on|off <list.json>");

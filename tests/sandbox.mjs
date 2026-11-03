// Throwaway Stash instances for testing the plugin, isolated from any real install.
//
//   node sandbox.mjs run <version> <port>     start one, run every check (test.mjs), stop
//   node sandbox.mjs start <version> <port>   download (once), configure, fill and keep it running
//   node sandbox.mjs stop                      stop every sandbox instance
//   node sandbox.mjs reload <port>             copy the plugin in again and reload plugins
//
// <version> is a release tag (v0.32.0) or "develop" for the latest development build.
// Everything lives in tests/.sandbox. Needs ffmpeg and ffprobe on PATH (or FFMPEG / FFPROBE).
import { spawn, execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { populate } from "./populate.mjs";
import { makeMedia } from "./make-media.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(process.env.SANDBOX_DIR || join(here, ".sandbox"));
const pluginSrc = resolve(here, "..", "InfiniteScroll");
const asset = { win32: "stash-win.exe", linux: "stash-linux", darwin: "stash-macos" }[process.platform];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function which(name, envVar) {
  if (process.env[envVar]) return process.env[envVar];
  try {
    const out = execFileSync(process.platform === "win32" ? "where" : "which", [name], { encoding: "utf8", windowsHide: true });
    return out.split(/\r?\n/)[0].trim();
  } catch (e) {
    throw new Error(`${name} not found on PATH; install it or set ${envVar}`);
  }
}

async function download(version) {
  const dir = join(root, "bin", version);
  const exe = join(dir, asset);
  if (existsSync(exe)) return exe;
  mkdirSync(dir, { recursive: true });
  const tag = version === "develop" ? "latest_develop" : version;
  const rel = await (await fetch(`https://api.github.com/repos/stashapp/stash/releases/tags/${tag}`)).json();
  const a = rel.assets && rel.assets.find((x) => x.name === asset);
  if (!a) throw new Error(`no ${asset} in release ${tag}`);
  console.log(`downloading ${tag} ${asset} (${Math.round(a.size / 1e6)} MB)`);
  const buf = Buffer.from(await (await fetch(a.browser_download_url)).arrayBuffer());
  writeFileSync(exe, buf);
  if (process.platform !== "win32") chmodSync(exe, 0o755);
  return exe;
}

function copyPlugin(cfg) {
  const dest = join(cfg, "plugins", "InfiniteScroll");
  rmSync(dest, { recursive: true, force: true });
  cpSync(pluginSrc, dest, { recursive: true });
}

async function gql(port, query) {
  const r = await fetch(`http://127.0.0.1:${port}/graphql`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query }) });
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors));
  return j.data;
}

async function start(version, port) {
  if (!version || !port) throw new Error("usage: node sandbox.mjs start <version> <port>");
  const media = join(root, "media");
  if (!existsSync(join(media, "done"))) {
    console.log("making test media");
    makeMedia(media, which("ffmpeg", "FFMPEG"));
    writeFileSync(join(media, "done"), "");
  }
  const exe = await download(version);
  const cfg = join(root, `cfg-${version}`);
  rmSync(cfg, { recursive: true, force: true });
  for (const d of ["generated", "cache", "blobs", "plugins", "scrapers"]) mkdirSync(join(cfg, d), { recursive: true });
  const p = (x) => x.replace(/\\/g, "/");
  writeFileSync(join(cfg, "config.yml"), [
    "stash:",
    `  - path: ${p(media)}`,
    "    excludevideo: false",
    "    excludeimage: false",
    `database: ${p(join(cfg, "stash-go.sqlite"))}`,
    `generated: ${p(join(cfg, "generated"))}`,
    `cache: ${p(join(cfg, "cache"))}`,
    `blobs_path: ${p(join(cfg, "blobs"))}`,
    "blobs_storage: FILESYSTEM",
    `plugins_path: ${p(join(cfg, "plugins"))}`,
    `scrapers_path: ${p(join(cfg, "scrapers"))}`,
    "host: 127.0.0.1",
    `port: ${port}`,
    "create_galleries_from_folders: true",
    "nobrowser: true",
    `ffmpeg_path: ${p(which("ffmpeg", "FFMPEG"))}`,
    `ffprobe_path: ${p(which("ffprobe", "FFPROBE"))}`,
    "",
  ].join("\n"));
  copyPlugin(cfg);
  // Not "detached": on Windows that starts Stash with no console at all, and then
  // every ffmpeg / ffprobe it runs while scanning opens a console window of its
  // own. With windowsHide it gets a hidden console, which those share.
  const child = spawn(exe, ["--config", join(cfg, "config.yml"), "--nobrowser"], { cwd: cfg, stdio: "ignore", windowsHide: true });
  writeFileSync(join(cfg, "pid"), String(child.pid));
  // a hidden-console child lives only as long as this script, so start stays
  // running (Ctrl+C or "stop" ends it) and "run" does everything in one go
  const end = () => { try { child.kill(); } catch (e) { /* gone */ } rmSync(join(cfg, "pid"), { force: true }); };
  process.on("SIGINT", () => { end(); process.exit(130); });
  process.on("exit", end);
  for (let i = 0; ; i++) {
    try {
      const d = await gql(port, "{ systemStatus { status } version { version } }");
      if (d.systemStatus.status === "OK") { console.log(`started ${d.version.version} on http://127.0.0.1:${port}`); break; }
    } catch (e) {
      if (i > 60) throw new Error("sandbox Stash didn't start");
    }
    await sleep(1000);
  }
  await populate(port);
}

function stop() {
  if (!existsSync(root)) return;
  for (const d of readdirSync(root).filter((x) => x.startsWith("cfg-"))) {
    const f = join(root, d, "pid");
    if (!existsSync(f)) continue;
    try { process.kill(Number(readFileSync(f, "utf8")), "SIGTERM"); console.log(`stopped ${d}`); } catch (e) { /* already gone */ }
    rmSync(f);
  }
}

async function reload(port) {
  for (const d of readdirSync(root).filter((x) => x.startsWith("cfg-"))) {
    if (readFileSync(join(root, d, "config.yml"), "utf8").includes(`port: ${port}\n`)) copyPlugin(join(root, d));
  }
  await gql(port, "mutation { reloadPlugins }");
  console.log("plugin reloaded");
}

const [cmd, a, b] = process.argv.slice(2);
if (cmd === "start") {
  await start(a, b);
  console.log("running; press Ctrl+C to stop it");
  setInterval(() => {}, 1 << 30);
} else if (cmd === "run") {
  await start(a, b);
  const t = spawn(process.execPath, [join(here, "test.mjs"), b, a], { stdio: "inherit", windowsHide: true, env: process.env });
  const code = await new Promise((r) => t.on("exit", r));
  process.exit(code ?? 1);
} else if (cmd === "stop") stop();
else if (cmd === "reload") await reload(a);
else console.log("usage: node sandbox.mjs run <version> <port> | start <version> <port> | stop | reload <port>");

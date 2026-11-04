// Media for the README demo: short clips cut from Blender's open movies
// (CC BY, https://studio.blender.org/films/), so the demo library looks like
// real footage without showing anything private.
//   node make-demo-media.mjs <srcdir> <outdir> [count]
// <srcdir> holds the downloaded films (see FILMS); writes <outdir>/videos/*.mp4
// and <outdir>/done. Every ffmpeg runs hidden.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

// file, title, and the stretch to cut from (seconds), skipping titles and credits
export const FILMS = [
  { file: "big-buck-bunny-640x360.m4v", title: "Big Buck Bunny", from: 25, to: 480,
    url: "https://download.blender.org/peach/bigbuckbunny_movies/BigBuckBunny_640x360.m4v.zip" },
  { file: "elephants-dream-480p.mov", title: "Elephants Dream", from: 30, to: 572,
    url: "https://download.blender.org/ED/elephantsdream-480-h264-st-aac.mov" },
  { file: "tears-of-steel-720p.mov", title: "Tears of Steel", from: 30, to: 580,
    url: "https://download.blender.org/demo/movies/ToS/tears_of_steel_720p.mov" },
];

const [srcArg, outArg, countArg] = process.argv.slice(2);
if (!srcArg || !outArg) throw new Error("usage: node make-demo-media.mjs <srcdir> <outdir> [count]");
const src = resolve(srcArg), out = resolve(outArg), count = Number(countArg || 168);
const ffmpeg = process.env.FFMPEG || "ffmpeg";
for (const f of FILMS) if (!existsSync(join(src, f.file))) throw new Error(`missing ${f.file}; download ${f.url}`);

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "videos"), { recursive: true });
const per = Math.ceil(count / FILMS.length);
for (let i = 0; i < count; i++) {
  // films take turns, so neighbouring tiles come from different films
  const f = FILMS[i % FILMS.length], k = Math.floor(i / FILMS.length);
  const start = f.from + ((f.to - f.from - 8) * k) / Math.max(1, per - 1);
  const name = `${String(i + 1).padStart(3, "0")} ${f.title} ${String(k + 1).padStart(2, "0")}.mp4`;
  execFileSync(ffmpeg, ["-v", "error", "-y", "-ss", start.toFixed(2), "-i", join(src, f.file), "-t", "8", "-an",
    "-vf", "scale=640:360:force_original_aspect_ratio=increase,crop=640:360,setsar=1",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "26", "-pix_fmt", "yuv420p", join(out, "videos", name)],
    { windowsHide: true, stdio: "ignore" });
  if ((i + 1) % 24 === 0) console.log(`${i + 1}/${count}`);
}
writeFileSync(join(out, "done"), "");
console.log("done");

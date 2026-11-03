// A small fake library: 90 short videos, 60 loose images and 3 folders of 20 images
// (which Stash turns into galleries). Plain test patterns, no text, so no fonts needed.
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

export function makeMedia(dir, ffmpeg) {
  rmSync(dir, { recursive: true, force: true });
  const run = (args) => execFileSync(ffmpeg, ["-v", "error", "-y", ...args], { windowsHide: true, stdio: "ignore" });
  const pad = (n) => String(n).padStart(2, "0");
  const hex = (n) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, "0");
  mkdirSync(join(dir, "videos"), { recursive: true });
  for (let i = 1; i <= 90; i++) {
    run(["-f", "lavfi", "-i", `testsrc2=size=320x180:rate=15:duration=${(i % 7) + 2}`, "-vf", `hue=h=${(i * 37) % 360}`,
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", join(dir, "videos", `scene-${pad(i)}.mp4`)]);
  }
  mkdirSync(join(dir, "images"), { recursive: true });
  for (let i = 1; i <= 60; i++) {
    run(["-f", "lavfi", "-i", `color=c=0x${hex(i * 4)}${hex(255 - i * 4)}78:size=${300 + (i % 3) * 100}x400`, "-frames:v", "1", join(dir, "images", `image-${pad(i)}.png`)]);
  }
  for (let g = 1; g <= 3; g++) {
    const gd = join(dir, "galleries", `Gallery ${g}`);
    mkdirSync(gd, { recursive: true });
    for (let i = 1; i <= 20; i++) {
      run(["-f", "lavfi", "-i", `color=c=0x30${hex(g * 60 + i)}a0:size=400x300`, "-frames:v", "1", join(gd, `g${g}-${pad(i)}.png`)]);
    }
  }
}

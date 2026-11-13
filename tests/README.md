# Tests

Browser checks for the plugin, run against throwaway Stash instances that have only this plugin installed. Nothing touches a real Stash install: each sandbox has its own folder, database and port, and listens on `127.0.0.1` only.

## Needs

- Node 18 or newer
- ffmpeg and ffprobe on PATH (or set `FFMPEG` and `FFPROBE`)
- Google Chrome, or Playwright's own Chromium (`npx playwright install chromium`, then set `BROWSER_CHANNEL=""`)

## Run

```sh
cd tests
npm install
node sandbox.mjs run v0.32.0 9912       # downloads that release once, fills a test library, runs every check, stops
```

Use `develop` as the version for the latest development build. It prints PASS or FAIL per check and exits with an error if any fail.

To poke at a sandbox yourself, `node sandbox.mjs start v0.32.0 9912` keeps it running at `http://127.0.0.1:9912` until you press Ctrl+C. Meanwhile `node test.mjs 9912` runs the checks against it, and after changing the plugin `node sandbox.mjs reload 9912` copies it in again. Several versions can run side by side on different ports.

Nothing opens a window while it runs: the sandbox Stash and everything it starts (ffmpeg while scanning) run hidden, and the browser is headless.

`ONLY=<regex>` runs just the matching checks (for example `ONLY="back from"`), and `TRACE=1` prints the plugin's own trace. Reports are written to `.sandbox/report-<label>.json`, with any console errors and which check they happened in.

`node stress.mjs 9912` flings the scene, performer, Wall and image lists up and down and fails on any `removeChild` / `insertBefore` error or Stash's "Something went wrong" screen. `INJECT=translate` makes it rewrite the list's text the way Chrome's page translation does (the cause of the v1.1.0 crash). `INJECT=wrap` wraps each card in a foreign element, as some other plugins do (the cause of the v1.1.1 crash), and `INJECT=remove` deletes an element inside each card. `WHERE=1` logs which element React tripped over.

The test library is 90 short videos, 120 images (3 of its folders become galleries), 40 performers, 20 studios, 40 tags, 18 groups and 40 markers. The first studio, performer, tag and group hold most of it, so their pages need several batches.

## Demo recording

The README's demo shows the scene Wall in a sandbox filled with 168 eight-second clips cut from Blender's open movies (Big Buck Bunny, Elephants Dream, Tears of Steel; CC BY, https://studio.blender.org/films/). Download the three films listed in `make-demo-media.mjs` into a folder of your choice, saved under the file names listed there (one folder can serve several projects), then:

```sh
node make-demo-media.mjs <films folder> .sandbox/demo/media
SANDBOX_DIR=.sandbox/demo node sandbox.mjs start v0.32.0 9931   # leave running
node record-demo.mjs 9931                                        # writes .sandbox/demo/demo.avif, demo.gif and demo.mp4
```

## What's checked

1. Every list type and the lists on studio, performer, tag, group and gallery pages load all their items, without duplicates, with the end marker, the page number in the address bar, and a pinned toolbar that stays clickable (below the name bar on detail pages).
2. List, Wall and Tagger views load everything.
3. Going back from a scene returns to the same card with everything loaded.
4. A link to a later page offers "Load earlier results" without the view jumping.
5. Select all covers every loaded item.
6. Changing the sort starts a fresh list.
7. The image lightbox loads more images as you step through.
8. Off-screen cards turn into placeholders and come back.
9. The back-to-top button.
10. Phone-width window.
11. The "Disable in Grid view" setting gives Stash's normal pages back.
12. Hover previews still play.
13. Reloading mid-list keeps the position.

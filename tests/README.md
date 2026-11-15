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

`node neighbours.mjs 9912` checks the plugin next to others that patch the same components, using three small stand-in plugins it installs and removes again:

- one renders the card's other patches inside its own element, as Hover Cards does. Cards already shown must survive a new batch, turn into placeholders of the same size and back, and an image's own page must survive renaming and saving with a wrapped performer card (the v1.1.2 image-page crash);
- one changes a card's arguments (some of them through Stash's own patch function, kept before Infinite Scroll wraps it) and returns an array, or nothing, from an "after" patch, which must come through whole, through placeholders, with no added argument drawn beside the card;
- one patches after Infinite Scroll the way Stash's docs show, and must get its next function while loading keeps working.

The first two must load before Infinite Scroll, and the checks fail if they don't.

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
9. Shift-click right after more has loaded selects the whole range (drawn cards skip the list update a new batch causes, so their click handlers are briefly a batch behind).
10. The cards of a new batch start as placeholders the size of the list's cards, and none is left empty on screen.
11. With every thumbnail held back 1.2 s, at most four load at once and the list still loads to its end.
12. The back-to-top button.
13. Phone-width window.
14. The "Disable in Grid view" setting gives Stash's normal pages back.
15. A longer load-ahead distance loads more before you scroll, and a distance saved by 1.1.4 or older (in screens) still counts until the percent one is set.
16. Hover previews still play.
17. Reloading mid-list keeps the position.

## How scrolling feels

`perf.mjs` scrolls a list at a steady pace, the way a mouse wheel does, and reports what a person would notice: late frames, how long the picture stood still, empty cards on screen and time spent waiting at the bottom.

```sh
node perf-lab.mjs media <clips folder> .sandbox/perf-media   # once: 504 scenes and 672 photo-sized images from the demo clips
node perf-lab.mjs start main 9960 .sandbox/perf-media        # a Stash with those and 600 performers; leave running
node perf.mjs 9960 /performers                               # three runs, then a summary line
```

- `PACE` is rows of cards per second, so the experience is the same whatever the card size (default 6; 2 is brisk, 5 is fast).
- `CPU=4` slows the page's main thread four times, standing in for a much slower PC.
- `DELAY=150` holds every picture back that long, standing in for a slow disk.
- `PROFILE=1` and `TRACE=1` say where the time went (by script, and by kind of browser work).
- Each run starts in a new browser profile, with a real GPU, and the wheel keeps turning on the clock even while the page is busy.

In the summary, `over33` and `over100` count frames that took longer than that many ms, `stuckMsPerS` is how long the picture stood still per second of scrolling, `blankPct` is how often an empty card was on screen, `noPicPct` how often a drawn card on screen was still without its picture, and `waitPct` how often the view sat at the bottom waiting. Each is the middle of the runs with the range. Each run's own line also has `gqlQueuedMs`: how long the plugin's requests for more items waited for a free connection.

For a slow disk, build the media on it (or copy it there) and start a second lab on that folder with `NO_THUMBS=1`, so Stash has to read the originals to make each thumbnail as it's first shown. Empty that lab's `generated/thumbnails` folder before each run to repeat it.

`node perf-lab.mjs plugins 9960 install list.json` installs other plugins from their sources (`[{ "id": "...", "source": "https://.../index.yml" }]`), and `plugins 9960 on|off list.json` switches them, to measure next to them. `GENERATED=<folder>` at the first start puts Stash's generated files on another disk, and `NO_THUMBS=1` leaves image thumbnails to be made as they're first shown.

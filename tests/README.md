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
node sandbox.mjs start v0.32.0 9912     # downloads that Stash release once, fills a test library
node test.mjs 9912 v0.32.0              # prints PASS / FAIL per check
node sandbox.mjs stop
```

Use `develop` as the version for the latest development build. Several versions can run side by side on different ports. After changing the plugin, `node sandbox.mjs reload <port>` copies it in again without rebuilding the sandbox.

`ONLY=<regex>` runs just the matching checks (for example `ONLY="back from"`), and `TRACE=1` prints the plugin's own trace. Reports are written to `.sandbox/report-<label>.json`, with any console errors and which check they happened in.

The test library is 90 short videos, 120 images (3 of its folders become galleries), 40 performers, 20 studios, 40 tags, 18 groups and 40 markers. The first studio, performer, tag and group hold most of it, so their pages need several batches.

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

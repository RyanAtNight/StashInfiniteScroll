# Infinite Scroll for Stash

Replaces pagination with infinite scrolling in every Stash list: scenes, images, galleries, performers, studios, tags, groups and markers, in Grid, List, Wall and Tagger views. It also works in the lists on performer, studio, tag, group and gallery pages.

Tested against Stash v0.31.1. The code was also checked against the development branch as of October 2026.

## Install

1. Copy this `InfiniteScroll` folder into your Stash plugins folder (shown under Settings → System → Plugins Path).
2. In Stash, go to Settings → Plugins and click **Reload plugins**.
3. Reload the browser tab.

## What it does

- **Loads items in small batches of 14 before you reach the bottom.** The batch size is fixed and the per-page dropdown is hidden. 14 was picked by benchmarking scrolling at a fast human pace with previews playing: smaller batches fell behind, larger ones stuttered as they arrived.
- **Loads further ahead the faster you scroll.** It always keeps at least 1.5 screens loaded below the view (configurable), more when you scroll fast, and fetches up to 4 batches at once when one at a time can't keep up.
- **Keeps your place.** The page number in the address bar follows the page you're looking at.
  - Going back from a scene returns you to the same item, with everything you had loaded.
  - Reloading or opening a copied link starts at that page, with a **Load earlier results** button at the top. Scrolling up also loads the earlier pages, without the view jumping.
  - A link from before the plugin (or with another page size) is converted to batches of 14 at the same position.
- **The list header stays pinned.** The toolbar, filter tags, page buttons and result count stay at the top while the list scrolls under them. Nothing moves or changes size; they just stop scrolling. Behind them the background is see-through, and clicks on empty parts reach the cards underneath. The selection indicator ("✕ 3 ☑") is a solid blue pill so it stays readable.
- **The page buttons show the page in view.** Pages are batches of 14. Clicking a page that's already loaded scrolls to it; any other page loads fresh from there. The bottom pagination is hidden.
- **The count shows the total** (for example "18,397"), not a page range.
- **A back-to-top button** appears at the bottom right once you've scrolled past the first screen. It keeps everything loaded.
- **The sidebar toggle is solid and always on top.** Stash draws it half-transparent, and a hovered card raised by another plugin, or a Wall view checkbox, could cover it, so a click opened a scene instead of toggling the sidebar.
- **Changing the filter, sort or search** starts a fresh list from the top.
- **Random sort stays stable**: every batch uses the same random seed.

### Keeping the data right

- **Items added or removed while you scroll** (deleting, or tagging scenes out of a "missing StashDB ID" filter) shift every later batch. When the total count changes, the plugin re-fetches everything loaded, in as few requests as possible, so nothing is skipped or shown twice. Your scroll position is kept.
- **After a library scan**, Stash clears its data cache. The missing batches are fetched again automatically.
- **A failed load** shows a Retry link and is also retried automatically after 5 seconds. A once-a-second check makes sure loading can't silently stop.

### Stash features that keep working

- **Selection:** "Select all", shift-click ranges and bulk edit/delete cover every loaded item. The Grid placeholders described below don't affect this.
- **Play queue:** clicking a scene builds the queue from the right position, whichever page is in view.
- **Image lightbox:** it steps through all loaded images and loads more before you reach the end.
- **Tagger:** "Scrape All" asks for confirmation when more than 40 scenes are loaded, since it sends a request per scene.

### Staying fast

- **Grid cards** far off-screen (more than 3 screens away) are swapped for empty boxes of the same size. With 700 scenes loaded, about 100 cards are actually rendered. The tagger is never affected, so its search results and matches are kept.
- **Cards coming back into range are drawn a few per frame**, nearest to the screen first, within about 8 ms a frame, instead of all at once in one long frame.
- **Previews wait while you scroll fast.** "Fast" is more than one screen height a second, so it means the same thing at every zoom level. Previews you fly past are never downloaded and don't hold up loading (browsers only open about 6 connections to Stash at once); about 0.15 s after you slow down, the ones on screen start playing.
- **Only on-screen preview videos play.** In Wall view, videos within half a screen stay loaded but paused, so they resume instantly when scrolled back into view; those further away are unloaded. Card previews that have played are unloaded when they move away and reload only when played again.
- **The address bar** is updated without telling Stash's router. Otherwise Stash would treat each new page as a filter change and redo work for every loaded item.

## Settings

Under Settings → Plugins → Infinite Scroll:

| Setting | Default | |
|---|---|---|
| Disable in Grid / List / Wall / Tagger view | off | Use normal pages in that view. |
| Disable on detail pages | off | Use normal pages for lists inside performer, studio, tag, group and gallery pages. |
| Hide the page jumper | off | Hide the page buttons above the list. |
| Don't pin the list header | off | Let the toolbar, filter tags, page buttons and count scroll away. |
| Keep every card mounted | off | Turn off the Grid placeholders. |
| Load-ahead distance (screens) | 1.5 | The least that's kept loaded below the view; fast scrolling loads further. |
| Tagger confirmation threshold | 40 | When "Scrape All" asks first. |

Settings take effect when you next open a page.

## Known limitations

- **Arrow-key page shortcuts** (← / →) step from the page you arrived on, not the page in view. Use the page buttons instead.
- **The lightbox counter on v0.31.1** counts loaded images (for example "119 / 160") rather than all results. Newer Stash versions show the full total.
- **After a library scan**, the restored list can be off by a row.
- **Browser find (Ctrl+F)** only finds text in rendered cards. Off-screen Grid cards are placeholders.
- **Where the plugin is switched off** for a view, that view keeps the 14-per-page setting until you change it.

## How it works

Stash's lists render whatever their GraphQL query returns. The plugin adds a read policy to the Apollo cache for the `find*` fields. For a list it is tracking, reading any loaded page returns every loaded page, merged and de-duplicated. Stash's own list components then render all of them, which is why every view and feature keeps working unchanged.

The plugin also patches:

- **The list renderers** (`SceneList`, `ImageList`, …): the loading markers, position tracking and the queue and lightbox fixes.
- **The card components:** the off-screen placeholders.
- **`Pagination` and `PaginationIndex`:** the page buttons and the counter.
- **`HTMLMediaElement.play`**, only for videos inside an infinite list, and only while scrolling fast: holding previews back.

If a Stash update removes anything it relies on, that part switches off and normal pagination is used.

`window.InfiniteScrollDebug` exposes the plugin's state in the browser console.

// Infinite Scroll for Stash
//
// How it works, in short:
//   * Stash's list pages render whatever their GraphQL query returns. We add a
//     cache read policy to the find* query fields so that, for a list we are
//     tracking, reading page N returns every loaded page (first..last) merged
//     and de-duplicated. Stash's own grid / list / wall / tagger views then
//     render all loaded items natively - selection, tagging, previews and
//     bulk operations keep working without being re-implemented.
//   * We patch each list's inner renderer (SceneList, ImageList, ...) to add
//     the scroll sentinels, URL/position syncing, and per-view fix-ups.
//   * We patch the card components (SceneCard, ImageCard, ...) to swap far
//     off-screen cards for same-sized placeholders, and unload off-screen
//     videos, so long sessions stay fast.
//
// If anything the plugin depends on is missing (a Stash update renamed it),
// the affected part turns itself off and Stash's normal pagination is used.
(function () {
  "use strict";

  const PLUGIN_ID = "InfiniteScroll";
  const LOG_PREFIX = "[InfiniteScroll]";

  const api = window.PluginApi;
  if (!api || !api.patch || !api.libraries || !api.libraries.Apollo) {
    console.warn(LOG_PREFIX, "PluginApi not available; plugin disabled");
    return;
  }

  const { React } = api;
  const { Apollo, ReactRouterDOM, Intl, Bootstrap } = api.libraries;
  const h = React.createElement;

  const DisplayMode = { Grid: 0, List: 1, Wall: 2, Tagger: 3 };

  // The inner list renderer for each entity type, the GraphQL field its data
  // comes from, and the prop / result key holding the items.
  const LISTS = {
    SceneList: { field: "findScenes", itemsKey: "scenes", prop: "scenes" },
    ImageList: { field: "findImages", itemsKey: "images", prop: "images" },
    GalleryList: { field: "findGalleries", itemsKey: "galleries", prop: "galleries" },
    PerformerList: { field: "findPerformers", itemsKey: "performers", prop: "performers" },
    StudioList: { field: "findStudios", itemsKey: "studios", prop: "studios" },
    TagList: { field: "findTags", itemsKey: "tags", prop: "tags" },
    GroupList: { field: "findGroups", itemsKey: "groups", prop: "groups" },
    SceneMarkerList: { field: "findSceneMarkers", itemsKey: "scene_markers", prop: "markers" },
  };

  // top-level list routes; anything else is a list inside a detail page tab
  const TOP_LEVEL_LIST_PATH =
    /^\/(scenes|scenes\/markers|images|galleries|performers|studios|tags|groups|movies)\/?$/;

  // largest single request made when re-fetching a loaded range
  const MAX_ITEMS_PER_REQUEST = 1000;
  // how far outside the viewport cards stay mounted, in viewport heights
  const WINDOW_SCREENS = 3;
  // how far outside the viewport videos stay loaded (paused), in viewport
  // heights; only videos actually on screen play
  const VIDEO_SCREENS = 0.5;
  const MAX_ENTRIES = 40;
  const MAX_SIZE_CACHE = 20000;

  // ---------------------------------------------------------------------------
  // settings

  const settings = {
    disableGrid: false,
    disableList: false,
    disableWall: false,
    disableTagger: false,
    disableOnDetailPages: false,
    hidePageJumper: false,
    disableWindowing: false,
    disablePinnedHeader: false,
    prefetchScreens: 1.5,
    taggerConfirmThreshold: 0,
  };

  function getClient() {
    try {
      return api.utils.StashService.getClient();
    } catch (e) {
      return undefined;
    }
  }

  async function loadSettings() {
    const client = getClient();
    if (!client || !api.GQL.ConfigurationDocument) return;
    try {
      const res = await client.query({
        query: api.GQL.ConfigurationDocument,
        fetchPolicy: "cache-first",
      });
      const cfg = (res.data && res.data.configuration && res.data.configuration.plugins &&
        res.data.configuration.plugins[PLUGIN_ID]) || {};
      for (const k of Object.keys(settings)) {
        const v = cfg[k];
        if (v === undefined || v === null) continue;
        if (typeof settings[k] === "number") {
          const n = Number(v);
          if (Number.isFinite(n) && n > 0) settings[k] = n;
        } else {
          settings[k] = !!v;
        }
      }
    } catch (e) {
      console.warn(LOG_PREFIX, "could not load settings", e);
    }
  }

  function modeEnabled(mode) {
    switch (mode) {
      case DisplayMode.Grid:
        return !settings.disableGrid;
      case DisplayMode.List:
        return !settings.disableList;
      case DisplayMode.Wall:
        return !settings.disableWall;
      case DisplayMode.Tagger:
        return !settings.disableTagger;
      default:
        return false;
    }
  }

  // ---------------------------------------------------------------------------
  // small utilities

  function stableStringify(v) {
    if (v === null || typeof v !== "object") return JSON.stringify(v);
    if (Array.isArray(v)) {
      return "[" + v.map((x) => (x === undefined ? "null" : stableStringify(x))).join(",") + "]";
    }
    return (
      "{" +
      Object.keys(v)
        .filter((k) => v[k] !== undefined)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + stableStringify(v[k]))
        .join(",") +
      "}"
    );
  }

  function hashString(s) {
    let h1 = 5381;
    for (let i = 0; i < s.length; i++) h1 = ((h1 << 5) + h1 + s.charCodeAt(i)) | 0;
    return (h1 >>> 0).toString(36);
  }

  // the list identity: the field plus all arguments except the page number
  function keyFor(field, args) {
    const filter = Object.assign({}, args.filter);
    delete filter.page;
    return field + stableStringify(Object.assign({}, args, { filter }));
  }

  function withPage(obj, page, perPage) {
    const filter = Object.assign({}, obj.filter, { page });
    if (perPage !== undefined) filter.per_page = perPage;
    return Object.assign({}, obj, { filter });
  }

  function valueFromNode(node, vars) {
    switch (node.kind) {
      case "Variable":
        return vars ? vars[node.name.value] : undefined;
      case "IntValue":
        return parseInt(node.value, 10);
      case "FloatValue":
        return parseFloat(node.value);
      case "StringValue":
      case "EnumValue":
      case "BooleanValue":
        return node.value;
      case "NullValue":
        return null;
      case "ListValue":
        return node.values.map((n) => valueFromNode(n, vars));
      case "ObjectValue": {
        const o = {};
        for (const f of node.fields) o[f.name.value] = valueFromNode(f.value, vars);
        return o;
      }
      default:
        return undefined;
    }
  }

  // Maps a query's variables to the arguments of `field`, so that the key we
  // compute here matches the args Apollo passes to the field read function.
  function argsFromDocument(doc, field, vars) {
    for (const def of doc.definitions || []) {
      if (def.kind !== "OperationDefinition") continue;
      for (const sel of def.selectionSet.selections) {
        if (sel.kind !== "Field" || sel.name.value !== field) continue;
        const args = {};
        for (const arg of sel.arguments || []) {
          const v = valueFromNode(arg.value, vars);
          if (v !== undefined) args[arg.name.value] = v;
        }
        return args;
      }
    }
    return undefined;
  }

  function navbarBottom() {
    const nav = document.querySelector(".navbar.fixed-top, .top-nav");
    return nav ? Math.max(0, nav.getBoundingClientRect().bottom) : 0;
  }

  function sessionGet(k) {
    try {
      const v = window.sessionStorage.getItem(k);
      return v ? JSON.parse(v) : undefined;
    } catch (e) {
      return undefined;
    }
  }

  function sessionSet(k, v) {
    try {
      window.sessionStorage.setItem(k, JSON.stringify(v));
    } catch (e) {
      // storage unavailable or full; position memory is best-effort
    }
  }

  // ---------------------------------------------------------------------------
  // scroll-to-top suppression
  //
  // Stash scrolls to the top whenever the list's page number changes. When the
  // page number changes because *we* updated the URL to match the page in
  // view, that jump has to be swallowed.

  const nativeScrollTo = window.scrollTo.bind(window);
  let scrollSuppression = null;

  window.scrollTo = function () {
    const s = scrollSuppression;
    if (s && performance.now() < s.until && window.location.pathname === s.path) {
      scrollSuppression = null;
      return;
    }
    return nativeScrollTo.apply(window, arguments);
  };

  // when the plugin itself last scrolled (restoring a position)
  let lastProgrammaticScroll = -Infinity;

  function suppressNextScrollToTop() {
    scrollSuppression = { until: performance.now() + 1500, path: window.location.pathname };
  }

  // ---------------------------------------------------------------------------
  // list state store
  //
  // One entry per list identity (field + filter without page). Entries live
  // outside React so they survive the list unmounting (navigating to a scene
  // and back), which is what makes position restoring instant.

  const store = new Map();
  const versionVar = Apollo.makeVar(0);
  let rawReads = 0;

  function bump() {
    versionVar(versionVar() + 1);
  }

  function touchEntry(st) {
    store.delete(st.key);
    store.set(st.key, st);
    while (store.size > MAX_ENTRIES) store.delete(store.keys().next().value);
  }

  function totalPages(st) {
    if (st.count === undefined || st.count === null) return Infinity;
    return Math.max(1, Math.ceil(st.count / st.perPage));
  }

  function pageVars(st, page) {
    return withPage(st.vars, page);
  }

  function notify(st) {
    st.listeners.forEach((fn) => fn());
  }

  function resetEntry(st, page) {
    if (window.InfiniteScrollDebug && window.InfiniteScrollDebug.trace) {
      console.debug(LOG_PREFIX, "reset", page, st.first, st.last, new Error().stack);
    }
    st.gen++;
    st.first = page;
    st.last = page;
    st.error = null;
    st.inflight.clear();
    st.anchor = undefined;
    st.pendingAnchor = undefined;
    st.run = { first: page, last: page, starts: [0], length: undefined };
    bump();
  }

  // ---------------------------------------------------------------------------
  // cache read policy

  function makeRead(field, itemsKey) {
    return function (existing, opts) {
      // register the dependency so that bump() re-runs this read
      versionVar();
      if (rawReads > 0 || existing === undefined || store.size === 0) return existing;
      const args = opts.args;
      if (!args || !args.filter) return existing;

      const page = args.filter.page || 1;
      const st = store.get(keyFor(field, args));
      if (!st || page < st.first || page > st.last) return existing;

      st.count = existing.count;
      if (st.first === st.last) {
        st.run = { first: page, last: page, starts: [0], length: (existing[itemsKey] || []).length };
        return existing;
      }

      rawReads++;
      try {
        const pages = new Map([[page, existing]]);
        const readPage = (p) => opts.readField({ fieldName: field, args: withPage(args, p) });
        // only a contiguous run of loaded pages around the requested one
        let lo = page;
        for (let p = page - 1; p >= st.first; p--) {
          const v = readPage(p);
          if (!v) break;
          pages.set(p, v);
          lo = p;
        }
        let hi = page;
        for (let p = page + 1; p <= st.last; p++) {
          const v = readPage(p);
          if (!v) break;
          pages.set(p, v);
          hi = p;
        }

        const seen = new Set();
        const out = [];
        const starts = [];
        for (let p = lo; p <= hi; p++) {
          starts.push(out.length);
          for (const item of pages.get(p)[itemsKey] || []) {
            const id = item && item.__ref;
            if (id) {
              // data can shift between page requests; never show an item twice
              if (seen.has(id)) continue;
              seen.add(id);
            }
            out.push(item);
          }
        }
        st.run = { first: lo, last: hi, starts, length: out.length };
        return Object.assign({}, existing, { [itemsKey]: out });
      } finally {
        rawReads--;
      }
    };
  }

  function installCachePolicies() {
    const client = getClient();
    const policies = client && client.cache && client.cache.policies;
    if (!policies || typeof policies.addTypePolicies !== "function") {
      console.warn(LOG_PREFIX, "Apollo cache policies unavailable; plugin disabled");
      return false;
    }
    const fields = {};
    for (const name of Object.keys(LISTS)) {
      const { field, itemsKey } = LISTS[name];
      fields[field] = { read: makeRead(field, itemsKey) };
    }
    policies.addTypePolicies({ Query: { fields } });
    return true;
  }

  // ---------------------------------------------------------------------------
  // locating the query behind a rendered list

  function findListQuery(cfg, items, filter) {
    const client = getClient();
    if (!client || typeof client.getObservableQueries !== "function") return undefined;
    let best;
    let bestScore = 0;
    client.getObservableQueries("active").forEach((oq) => {
      let data;
      try {
        const res = oq.getCurrentResult();
        data = res && res.data && res.data[cfg.field];
      } catch (e) {
        return;
      }
      if (!data || !Array.isArray(data[cfg.itemsKey])) return;
      const arr = data[cfg.itemsKey];
      let score = 0;
      if (arr === items) {
        score = 3;
      } else {
        const ff = (oq.variables && oq.variables.filter) || {};
        if (ff.per_page !== filter.itemsPerPage || (ff.page || 1) !== filter.currentPage) return;
        score =
          arr.length === items.length && (arr.length === 0 || (items[0] && arr[0].id === items[0].id))
            ? 2
            : 1;
      }
      if (score > bestScore) {
        best = oq;
        bestScore = score;
      }
    });
    return best;
  }

  function getOrCreateEntry(cfg, items, filter) {
    const oq = findListQuery(cfg, items, filter);
    if (!oq || !oq.variables || !oq.variables.filter) return undefined;
    const perPage = oq.variables.filter.per_page;
    if (!perPage || perPage < 1) return undefined;
    const args = argsFromDocument(oq.query, cfg.field, oq.variables);
    if (!args || !args.filter) return undefined;

    const key = keyFor(cfg.field, args);
    let st = store.get(key);
    const page = oq.variables.filter.page || 1;
    if (!st) {
      const vars = JSON.parse(JSON.stringify(oq.variables));
      delete vars.filter.page;
      let count;
      try {
        const d = oq.getCurrentResult().data[cfg.field];
        count = d.count;
      } catch (e) {
        count = undefined;
      }
      st = {
        key,
        storageKey: "isc:" + hashString(key),
        field: cfg.field,
        itemsKey: cfg.itemsKey,
        doc: oq.query,
        vars,
        perPage,
        first: page,
        last: page,
        count,
        ackCount: count,
        gen: 0,
        inflight: new Set(),
        refreshing: false,
        refreshAgain: false,
        error: null,
        anchor: undefined,
        pendingAnchor: undefined,
        urlPage: undefined,
        run: { first: page, last: page, starts: [0], length: items.length },
        // history entry keys this list has been shown at
        keys: new Set(),
        listeners: new Set(),
      };
    }
    touchEntry(st);
    return st;
  }

  // ---------------------------------------------------------------------------
  // loading

  async function loadPage(st, page) {
    if (st.refreshing || st.inflight.size > 0) return;
    if (page < 1 || page > totalPages(st)) return;
    if (page === st.last + 1) st.last = page;
    else if (page === st.first - 1) st.first = page;
    else return;

    const gen = st.gen;
    const countBefore = st.count;
    st.inflight.add(page);
    st.error = null;
    notify(st);
    try {
      // "no-cache" + writeQuery rather than a cached query: reading the
      // result back would merge every loaded page under this page's
      // variables, and Apollo memoises item results per variables, so it
      // would recompute every loaded item
      const client = getClient();
      const variables = pageVars(st, page);
      const res = await client.query({ query: st.doc, variables, fetchPolicy: "no-cache" });
      if (st.gen !== gen) return;
      client.cache.writeQuery({ query: st.doc, variables, data: res.data });
      const data = res.data && res.data[st.field];
      if (data && countBefore !== undefined && data.count !== countBefore) {
        // items were added or removed since earlier pages were fetched, so page
        // offsets moved: re-fetch the loaded range so nothing is skipped
        st.inflight.delete(page);
        st.ackCount = data.count;
        refreshRange(st);
      }
    } catch (e) {
      if (st.gen !== gen) return;
      console.warn(LOG_PREFIX, "failed to load page", page, e);
      st.pendingAnchor = undefined;
      st.error = e;
      if (page === st.last && st.last > st.first) st.last--;
      else if (page === st.first && st.first < st.last) st.first++;
    } finally {
      if (st.gen === gen) {
        st.inflight.delete(page);
        bump();
        notify(st);
      }
    }
  }

  // Re-fetches every loaded page in as few requests as possible and writes
  // them back to the cache in one batch (one re-render).
  async function refreshRange(st) {
    if (st.refreshing) {
      st.refreshAgain = true;
      return;
    }
    const client = getClient();
    const gen = st.gen;
    st.refreshing = true;
    st.error = null;
    notify(st);
    try {
      do {
        st.refreshAgain = false;
        const pp = st.perPage;
        const group = Math.max(1, Math.floor(MAX_ITEMS_PER_REQUEST / pp));
        const firstBlock = Math.floor((st.first - 1) / group);
        const lastBlock = Math.floor((st.last - 1) / group);
        const writes = [];
        let count;
        for (let b = firstBlock; b <= lastBlock; b++) {
          const res = await client.query({
            query: st.doc,
            variables: withPage(st.vars, b + 1, pp * group),
            fetchPolicy: "no-cache",
          });
          if (st.gen !== gen) return;
          const data = res.data[st.field];
          const all = data[st.itemsKey] || [];
          count = data.count;
          for (let i = 0; i < group; i++) {
            const p = b * group + i + 1;
            const slice = all.slice(i * pp, (i + 1) * pp);
            if (!slice.length && p > 1) break;
            writes.push({
              variables: pageVars(st, p),
              data: Object.assign({}, res.data, {
                [st.field]: Object.assign({}, data, { [st.itemsKey]: slice }),
              }),
            });
          }
        }
        if (count !== undefined) {
          st.count = count;
          st.ackCount = count;
          const maxPage = totalPages(st);
          if (st.last > maxPage) st.last = Math.max(st.first, maxPage);
        }
        if (st.holdPosition) st.holdPosition();
        const write = (cache) => {
          for (const w of writes) cache.writeQuery({ query: st.doc, variables: w.variables, data: w.data });
        };
        if (typeof client.cache.batch === "function") client.cache.batch({ update: write });
        else write(client.cache);
      } while (st.refreshAgain && st.gen === gen);
    } catch (e) {
      if (st.gen === gen) {
        console.warn(LOG_PREFIX, "failed to refresh loaded pages", e);
        st.pendingAnchor = undefined;
        st.error = e;
      }
    } finally {
      if (st.gen === gen) {
        st.refreshing = false;
        bump();
        notify(st);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // registry of mounted infinite lists (used by the Pagination patches and the
  // tagger confirmation)

  const activeLists = new Set();
  const registryListeners = new Set();

  function notifyRegistry() {
    registryListeners.forEach((fn) => fn());
  }

  function useRegistry() {
    const [, force] = React.useReducer((x) => x + 1, 0);
    React.useEffect(() => {
      registryListeners.add(force);
      return () => registryListeners.delete(force);
    }, []);
  }

  function matchActiveList(itemsPerPage, totalItems, currentPage) {
    for (const reg of activeLists) {
      if (
        reg.perPage === itemsPerPage &&
        reg.count === totalItems &&
        currentPage >= reg.run.first &&
        currentPage <= reg.run.last
      ) {
        return reg;
      }
    }
    return undefined;
  }

  // ---------------------------------------------------------------------------
  // windowing: far off-screen cards become same-sized placeholders

  const WindowCtx = React.createContext(null);
  const CARD_COMPONENTS = [
    "SceneCard",
    "ImageCard",
    "GalleryCard",
    "PerformerCard",
    "StudioCard",
    "TagCard",
    "GroupCard",
    "SceneMarkerCard",
  ];
  const sizeCache = new Map();
  const batchedUpdates = (api.ReactDOM && api.ReactDOM.unstable_batchedUpdates) || ((fn) => fn());

  function rememberSize(id, w, hgt) {
    sizeCache.delete(id);
    sizeCache.set(id, { w, h: hgt });
    if (sizeCache.size > MAX_SIZE_CACHE) sizeCache.delete(sizeCache.keys().next().value);
  }

  function createWindowCtl() {
    const callbacks = new Map();
    let io = null;
    const ctl = {
      enabled: false,
      margin: undefined,
      // ids currently shown as placeholders
      far: new Set(),
      // the latest props for each card, which a skipped (memoised)
      // placeholder needs when it turns back into a real card
      latest: new Map(),
      observe(el, fn) {
        if (!io) {
          io = new IntersectionObserver(
            (entries) =>
              // one render for all the cards that changed, not one each
              batchedUpdates(() => {
                for (const e of entries) {
                  const cb = callbacks.get(e.target);
                  if (cb) cb(e.isIntersecting, e.boundingClientRect);
                }
              }),
            { rootMargin: `${WINDOW_SCREENS * 100}% 0px ${WINDOW_SCREENS * 100}% 0px` }
          );
        }
        callbacks.set(el, fn);
        io.observe(el);
      },
      unobserve(el) {
        callbacks.delete(el);
        if (io) io.unobserve(el);
      },
      // synchronous re-evaluation, used right after a programmatic scroll so the
      // cards in view render before the next paint
      recheck() {
        const vh = window.innerHeight;
        batchedUpdates(() =>
          callbacks.forEach((cb, el) => {
            const r = el.getBoundingClientRect();
            cb(r.bottom > -WINDOW_SCREENS * vh && r.top < (WINDOW_SCREENS + 1) * vh, r);
          })
        );
      },
      destroy() {
        if (io) io.disconnect();
        io = null;
        callbacks.clear();
        ctl.far.clear();
        ctl.latest.clear();
      },
    };
    return ctl;
  }

  // renders a component function inline, inside a stable component type
  function Passthrough({ Original, props }) {
    return Original(props);
  }

  // the card's entity, e.g. props.scene for SceneCard: "Scene:123"
  function cardId(props) {
    for (const k of Object.keys(props)) {
      const v = props[k];
      if (v && typeof v === "object" && v.__typename && v.id !== undefined) return v.__typename + ":" + v.id;
    }
    return undefined;
  }

  function WindowedCard({ ctl, id, props: givenProps, Original: givenOriginal }) {
    const latest = id && ctl.latest.get(id);
    const props = latest ? latest.props : givenProps;
    const Original = latest ? latest.Original : givenOriginal;
    const ref = React.useRef(null);
    const [near, setNear] = React.useState(() => !(ctl.enabled && id && sizeCache.has(id)));
    const show = near || !ctl.enabled || !id || !sizeCache.has(id);
    const enabled = ctl.enabled && !!id;

    React.useLayoutEffect(() => {
      const el = show ? ref.current && ref.current.firstElementChild : ref.current;
      if (!el) return undefined;
      if (show) {
        el.setAttribute("data-isc-item", "");
        if (!ctl.margin) ctl.margin = window.getComputedStyle(el).margin;
      }
      if (!enabled) return undefined;
      ctl.observe(el, (isNear, rect) => {
        if (!isNear) {
          // a hidden card (e.g. inactive tab) has no size; leave it alone
          if (!rect.width || !rect.height) return;
          if (show) rememberSize(id, rect.width, rect.height);
        }
        setNear(isNear);
      });
      return () => ctl.unobserve(el);
    }, [show, enabled, id, ctl]);

    if (show) {
      if (id) ctl.far.delete(id);
      return h(
        "div",
        { ref, className: "isc-cell", style: { display: "contents" } },
        h(Passthrough, { Original, props })
      );
    }
    ctl.far.add(id);
    const s = sizeCache.get(id);
    const width = props.width || s.w;
    return h("div", {
      ref,
      className: "isc-ph",
      "data-isc-item": "",
      style: { width, height: s.h * (width / s.w), margin: ctl.margin },
    });
  }

  // A placeholder doesn't need to re-render when the list does; with hundreds
  // of cards loaded that is most of the cost of each list update.
  const MemoWindowedCard = React.memo(
    WindowedCard,
    (prev, next) =>
      prev.ctl === next.ctl &&
      prev.id === next.id &&
      !!next.id &&
      next.ctl.enabled &&
      next.ctl.far.has(next.id) &&
      prev.props.width === next.props.width
  );

  // ---------------------------------------------------------------------------
  // videos: only on-screen previews play; nearby ones stay loaded (paused) so
  // they resume instantly, and the rest are unloaded
  //
  // The bands are measured in screen heights, so they already hold fewer
  // videos at larger zoom levels, where each preview is bigger.

  function attachVideoManager(container) {
    const visible = new WeakSet();

    const playIfAllowed = (v) => {
      if (v.autoplay && v.paused && v.getAttribute("src")) v.play().catch(() => {});
    };

    // play / pause on actual visibility
    const viewIo = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const v = e.target;
        if (e.isIntersecting) {
          visible.add(v);
          playIfAllowed(v);
        } else {
          visible.delete(v);
          if (!v.paused) v.pause();
        }
      }
    });

    // load / unload within a band around the screen
    const loadIo = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const v = e.target;
          if (!e.isIntersecting) {
            const src = v.getAttribute("src");
            if (src) {
              v.dataset.iscSrc = src;
              v.pause();
              v.removeAttribute("src");
              v.load();
            }
          } else if (v.dataset.iscSrc) {
            if (!v.getAttribute("src")) {
              v.setAttribute("src", v.dataset.iscSrc);
              v.load();
              if (visible.has(v)) playIfAllowed(v);
            }
            delete v.dataset.iscSrc;
          }
        }
      },
      { rootMargin: `${VIDEO_SCREENS * 100}% 0px ${VIDEO_SCREENS * 100}% 0px` }
    );

    // the autoplay attribute starts a video as soon as it loads, on screen or
    // not; stop the ones that aren't visible
    const onPlay = (e) => {
      const v = e.target;
      if (v.tagName === "VIDEO" && !visible.has(v)) v.pause();
    };
    container.addEventListener("play", onPlay, true);

    const observed = new WeakSet();
    const scan = (root) => {
      const vids = root.tagName === "VIDEO" ? [root] : root.querySelectorAll ? root.querySelectorAll("video") : [];
      vids.forEach((v) => {
        if (!observed.has(v)) {
          observed.add(v);
          viewIo.observe(v);
          loadIo.observe(v);
        }
      });
    };
    const mo = new MutationObserver((records) => {
      for (const r of records) {
        r.addedNodes.forEach((n) => n.nodeType === 1 && scan(n));
        r.removedNodes.forEach((n) => {
          if (n.nodeType !== 1) return;
          const vids = n.tagName === "VIDEO" ? [n] : n.querySelectorAll("video");
          vids.forEach((v) => {
            viewIo.unobserve(v);
            loadIo.unobserve(v);
            observed.delete(v);
            visible.delete(v);
          });
        });
      }
    });
    mo.observe(container, { childList: true, subtree: true });
    scan(container);
    return () => {
      mo.disconnect();
      viewIo.disconnect();
      loadIo.disconnect();
      container.removeEventListener("play", onPlay, true);
    };
  }

  // ---------------------------------------------------------------------------
  // position helpers

  // item elements in DOM order; the first selector that matches one element per
  // item wins. null when the view's structure isn't recognised.
  const ITEM_SELECTORS = ["[data-isc-item]", ".wall-item", ".search-item", "tbody > tr"];

  function itemElements(container, count) {
    if (!container || !count) return null;
    for (const sel of ITEM_SELECTORS) {
      const els = container.querySelectorAll(sel);
      if (els.length === count) return els;
    }
    return null;
  }

  // index of the first item whose bottom edge is below y
  function firstVisibleIndex(els, y) {
    let lo = 0;
    let hi = els.length - 1;
    let ans = els.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (els[mid].getBoundingClientRect().bottom > y) {
        ans = mid;
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    }
    return ans;
  }

  function pageOfIndex(run, index) {
    let p = 0;
    for (let i = 0; i < run.starts.length; i++) {
      if (run.starts[i] <= index) p = i;
      else break;
    }
    return run.first + p;
  }

  // Was this list reached by back / forward, or a reload? Neither the router's
  // history.action nor popstate timing can tell reliably (the router renders
  // before other popstate listeners run, and Stash often normalises the URL
  // with history.replace). Instead: every history entry has a key, and
  // returning to an entry means returning to a key this list already showed.
  // A reload gets a new key (Stash rewrites the URL on load), so the first
  // mount of each list after a reload / back-forward page load matches the
  // saved anchor by its exact URL instead.
  const navEntry = performance.getEntriesByType && performance.getEntriesByType("navigation")[0];
  const loadedByRestore = !!navEntry && (navEntry.type === "reload" || navEntry.type === "back_forward");
  const mountedSinceLoad = new Set();

  function isReturnVisit(st, location) {
    const firstMount = !mountedSinceLoad.has(st.storageKey);
    mountedSinceLoad.add(st.storageKey);
    if (location.key && st.keys.has(location.key)) return true;
    const saved = sessionGet(st.storageKey);
    if (!saved) return false;
    if (location.key && saved.key === location.key) return true;
    return loadedByRestore && firstMount && saved.search === window.location.search;
  }

  function urlPage(search) {
    const m = /(?:^|[?&])p=(\d+)/.exec(search || "");
    return m ? parseInt(m[1], 10) : 1;
  }

  // a list that keeps its filter in the URL always has some of these params
  function urlDrivenList(search, filter) {
    return (
      /(?:^|[?&])(sortby|sortdir|disp|perPage|z|c)=/.test(search || "") &&
      urlPage(search) === filter.currentPage
    );
  }

  // Keeps the address bar's page number in step with the view. This goes
  // straight to the browser, not through the router: if Stash saw the page
  // change, it would re-run the list query with new variables and Apollo
  // would recompute every loaded item. Back / forward, reload and copied
  // links still see the page, since they read the real URL.
  function setAddressBarPage(page) {
    const loc = window.location;
    const url = loc.pathname + searchWithPage(loc.search, page) + loc.hash;
    try {
      window.history.replaceState(window.history.state, "", url);
    } catch (e) {
      // replaceState is rate-limited by browsers; the next check retries
    }
  }

  function searchWithPage(search, page) {
    let s = (search || "").replace(/([?&])p=\d+(&|$)/, (m, a, b) => (b ? a : ""));
    if (s === "?") s = "";
    if (page > 1) s += (s ? "&" : "?") + "p=" + page;
    return s;
  }

  // ---------------------------------------------------------------------------
  // pinned list header
  //
  // The toolbar, filter tags, page buttons and count stay at the top while the
  // list scrolls under them. They're made sticky in place, so at rest nothing
  // moves or changes size; each one sticks at the spot it starts from.

  const PINNED_HEADER = [".filtered-list-toolbar", ".filter-tags", ".pagination-index-container"];
  // a header starting further below the navbar than this (a list inside a
  // detail page) sticks right under the navbar instead of where it started
  const PIN_MAX_GAP = 80;

  function pinListHeader(listEl, onBottom) {
    const pane = listEl.parentElement;
    const els = PINNED_HEADER.map((sel) =>
      Array.prototype.find.call(pane.children, (c) => c.matches(sel))
    ).filter(Boolean);
    if (!els.length) return undefined;

    const layout = () => {
      // measure where everything sits at rest
      els.forEach((el) => el.classList.remove("isc-pin"));
      const nav = navbarBottom();
      const tops = els.map((el) => el.getBoundingClientRect().top + window.scrollY);
      const gap = tops[0] - nav;
      const first = nav + (gap >= 0 && gap < PIN_MAX_GAP ? gap : 0);
      els.forEach((el, i) => {
        el.style.setProperty("--isc-pin-top", `${first + tops[i] - tops[0]}px`);
        el.classList.add("isc-pin");
      });
      const last = els[els.length - 1];
      onBottom(first + tops[els.length - 1] - tops[0] + last.offsetHeight);
    };

    layout();
    let frame = 0;
    const relayout = () => {
      if (!frame) {
        frame = window.setTimeout(() => {
          frame = 0;
          layout();
        }, 50);
      }
    };
    // filter tags appearing or wrapping, the sidebar opening, window resizes
    const ro = new ResizeObserver(relayout);
    els.forEach((el) => ro.observe(el));
    window.addEventListener("resize", relayout);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", relayout);
      if (frame) window.clearTimeout(frame);
      els.forEach((el) => {
        el.classList.remove("isc-pin");
        el.style.removeProperty("--isc-pin-top");
      });
      onBottom(0);
    };
  }

  // ---------------------------------------------------------------------------
  // the list wrapper

  function useForceUpdate() {
    const [, force] = React.useReducer((x) => x + 1, 0);
    return force;
  }

  // Loading state lives on the entry, not in React state; the loaders subscribe
  // to it themselves so that showing a spinner doesn't re-render the list.
  function useEntryUpdates(st) {
    const force = useForceUpdate();
    React.useEffect(() => {
      st.listeners.add(force);
      return () => st.listeners.delete(force);
    }, [st, force]);
  }

  function Sentinel({ st, run, total, onRetry, sentinelRef, itemCount }) {
    useEntryUpdates(st);
    let content = null;
    if (st.error) {
      content = h(
        "span",
        null,
        "Couldn't load more results. ",
        h("button", { type: "button", className: "btn btn-link btn-sm p-0", onClick: onRetry }, "Retry")
      );
    } else if (st.inflight.size > 0 || st.refreshing) {
      content = h("span", { className: "isc-loading" }, h("span", { className: "isc-spinner" }), "Loading more…");
    } else if (run.last >= total && st.count !== undefined && itemCount > st.perPage) {
      content = h("span", null, `End of results · ${itemCount.toLocaleString()} loaded`);
    }
    return h("div", { className: "isc-sentinel", ref: sentinelRef }, content);
  }

  // Back to top. Shown once the list is scrolled down more than a screen; it
  // listens to scrolling itself, so showing / hiding it doesn't re-render the
  // list.
  function ScrollTopButton({ getScroller }) {
    const [shown, setShown] = React.useState(false);
    const getRef = React.useRef(getScroller);
    getRef.current = getScroller;

    React.useEffect(() => {
      let timer = 0;
      const update = () => {
        timer = 0;
        const sc = getRef.current();
        const y = sc ? sc.scrollTop : window.scrollY;
        setShown(y > (sc ? sc.clientHeight : window.innerHeight));
      };
      const onScroll = () => {
        if (!timer) timer = window.setTimeout(update, 100);
      };
      document.addEventListener("scroll", onScroll, { capture: true, passive: true });
      update();
      return () => {
        document.removeEventListener("scroll", onScroll, { capture: true });
        if (timer) window.clearTimeout(timer);
      };
    }, []);

    const onClick = () => {
      // ours, so it doesn't count as scrolling up into "load earlier"
      lastProgrammaticScroll = performance.now();
      const sc = getRef.current();
      if (sc) sc.scrollTop = 0;
      nativeScrollTo(0, 0);
    };

    const { ReactFontAwesome, FontAwesomeSolid } = api.libraries;
    const icon =
      ReactFontAwesome && FontAwesomeSolid && FontAwesomeSolid.faArrowUp
        ? h(ReactFontAwesome.FontAwesomeIcon, { icon: FontAwesomeSolid.faArrowUp })
        : "↑";

    return h(
      "button",
      {
        type: "button",
        className: "isc-to-top" + (shown ? "" : " isc-hidden"),
        title: "Back to top",
        "aria-label": "Back to top",
        tabIndex: shown ? 0 : -1,
        onClick,
      },
      icon
    );
  }

  function TopLoader({ st, run, onLoad, topRef }) {
    useEntryUpdates(st);
    if (run.first <= 1) return null;
    const busy = st.inflight.has(run.first - 1);
    return h(
      "div",
      { className: "isc-top", ref: topRef },
      h(
        "button",
        { type: "button", className: "btn btn-secondary btn-sm", onClick: onLoad, disabled: busy },
        busy ? "Loading…" : `Load earlier results (page ${run.first - 1})`
      )
    );
  }

  function InfiniteList({ name, cfg, props, Original }) {
    const history = ReactRouterDOM.useHistory();
    const location = ReactRouterDOM.useLocation();
    const containerRef = React.useRef(null);
    const sentinelRef = React.useRef(null);
    const topRef = React.useRef(null);
    const mountedRef = React.useRef(undefined);
    const stateRef = React.useRef({});
    const ctl = React.useMemo(() => createWindowCtl(), []);

    const filter = props.filter;
    const items = props[cfg.prop] || [];
    const mode = filter ? filter.displayMode : undefined;
    const detailPage = !TOP_LEVEL_LIST_PATH.test(location.pathname);
    const wanted =
      !!filter && filter.itemsPerPage > 0 && modeEnabled(mode) && !(detailPage && settings.disableOnDetailPages);

    const st = wanted ? getOrCreateEntry(cfg, items, filter) : undefined;
    const enabled = !!st;
    const run = st
      ? st.run && filter.currentPage >= st.run.first && filter.currentPage <= st.run.last
        ? st.run
        : { first: filter.currentPage, last: filter.currentPage, starts: [0], length: items.length }
      : undefined;

    ctl.enabled = enabled && mode === DisplayMode.Grid && !settings.disableWindowing;

    // everything the event handlers need, without re-binding them each render
    const S = stateRef.current;
    Object.assign(S, { st, run, items, filter, enabled, mode, history, location, name });

    // Lists decide queue positions and lightbox numbering from the filter's
    // page; with several pages merged that has to be the first loaded page.
    const passFilter = React.useMemo(() => {
      if (!enabled || !filter || run.first === filter.currentPage) return filter;
      const f = filter.clone();
      f.currentPage = run.first;
      return f;
    }, [enabled, filter, run && run.first]);

    let passProps = props;
    if (enabled) {
      passProps = Object.assign({}, props, { filter: passFilter });
      // the lightbox walks the merged list itself: no page switching, and no
      // "Page x / y" header (0 pages hides it)
      if (name === "ImageList") passProps.pageCount = 0;
    }

    // --- anchors ---------------------------------------------------------

    // Most views scroll the page, but some (the List view's table) scroll
    // inside their own box. Returns that box, or null for the page.
    function getScroller(els) {
      const c = containerRef.current;
      let el = els && els[0] ? els[0].parentElement : null;
      while (el && el !== c) {
        const oy = window.getComputedStyle(el).overflowY;
        if ((oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight + 1) return el;
        el = el.parentElement;
      }
      return null;
    }

    // the top edge items scroll under, and a way to scroll by an amount
    function viewportOf(scroller) {
      if (!scroller) {
        return {
          top: Math.max(navbarBottom(), S.pinBottom || 0),
          scrollBy: (d) => {
            lastProgrammaticScroll = performance.now();
            nativeScrollTo(0, window.scrollY + d);
          },
        };
      }
      const head = scroller.querySelector("thead");
      return {
        top: scroller.getBoundingClientRect().top + (head ? head.getBoundingClientRect().height : 0),
        scrollBy: (d) => {
          lastProgrammaticScroll = performance.now();
          scroller.scrollTop += d;
        },
      };
    }

    function captureAnchor() {
      const { st: s, items: its } = S;
      const els = itemElements(containerRef.current, its.length);
      if (!s || !els) return undefined;
      const idx = firstVisibleIndex(els, viewportOf(getScroller(els)).top);
      const item = its[idx];
      if (!item) return undefined;
      const page = pageOfIndex(S.run, idx);
      return {
        id: item.id,
        offset: els[idx].getBoundingClientRect().top,
        page,
        key: S.location.key,
        // the address bar URL this anchor belongs to (see setAddressBarPage)
        search: searchWithPage(window.location.search, page),
      };
    }

    function restoreAnchor(anchor) {
      const { items: its } = S;
      if (!anchor) return false;
      const idx = its.findIndex((i) => i.id === anchor.id);
      const els = itemElements(containerRef.current, its.length);
      if (idx < 0 || !els) return false;
      const top = els[idx].getBoundingClientRect().top;
      if (Math.abs(top - anchor.offset) > 1) viewportOf(getScroller(els)).scrollBy(top - anchor.offset);
      ctl.recheck();
      return true;
    }

    function scrollToPage(page) {
      const { run: r, items: its } = S;
      const els = itemElements(containerRef.current, its.length);
      const idx = r.starts[page - r.first];
      if (!els || idx === undefined || !els[idx]) return;
      const vp = viewportOf(getScroller(els));
      vp.scrollBy(els[idx].getBoundingClientRect().top - vp.top - 8);
      ctl.recheck();
    }

    // remember the item at the top of the view, to restore after items are
    // inserted above it (loading earlier pages, re-fetching the range)
    if (st) {
      st.holdPosition = () => {
        if (st.pendingAnchor) return;
        const anchor = captureAnchor();
        if (anchor) st.pendingAnchor = { anchor, items: S.items };
      };
    }

    // --- mount / page-change handling -----------------------------------

    React.useLayoutEffect(() => {
      if (!enabled) {
        mountedRef.current = undefined;
        return;
      }
      const page = filter.currentPage;
      const prev = mountedRef.current;
      mountedRef.current = { page, st };

      if (!prev || prev.st !== st) {
        // mounting, re-enabling, or the filter changed to another list: only
        // back / forward navigation (or a reload) restores, anything else
        // starts fresh
        const action = isReturnVisit(st, location) ? "POP" : "PUSH";
        const inRange = page >= st.first && page <= st.last;
        if (window.InfiniteScrollDebug && window.InfiniteScrollDebug.trace) {
          console.debug(LOG_PREFIX, "mount", action, page, st.first, st.last, !!prev, location.key);
        }
        st.urlPage = page;
        if (action === "POP" && inRange) {
          // back / forward / reload: put the user back where they were. After a
          // reload only this page is loaded, but the saved anchor still works.
          const anchor = st.anchor || sessionGet(st.storageKey);
          if (anchor && anchor.page === page) {
            // keep re-applying for a few frames while images settle
            st.restoring = true;
            let frames = 0;
            const attempt = () => {
              restoreAnchor(anchor);
              if (++frames < 10) window.setTimeout(attempt, 30);
              else st.restoring = false;
            };
            attempt();
          }
        } else if (!inRange || st.first !== st.last) {
          resetEntry(st, page);
        }
        return;
      }

      if (page === prev.page || page === st.urlPage) return;

      // the page changed from outside: pagination control, keyboard, etc
      st.urlPage = page;
      if (page >= run.first && page <= run.last) {
        suppressNextScrollToTop();
        scrollToPage(page);
      } else {
        resetEntry(st, page);
      }
    }, [enabled, filter && filter.currentPage, st]);

    // --- after every render --------------------------------------------

    React.useLayoutEffect(() => {
      if (!enabled) return;

      // (after the mount handling above, which needs to know whether this key
      // was seen before)
      if (location.key) {
        st.keys.add(location.key);
        if (st.keys.size > 200) st.keys.delete(st.keys.values().next().value);
      }

      // put the remembered item back where it was once the items actually
      // changed (not on the re-render that only shows the loading state)
      if (st.pendingAnchor && st.pendingAnchor.items !== items) {
        const a = st.pendingAnchor.anchor;
        st.pendingAnchor = undefined;
        restoreAnchor(a);
      }

      // count changed underneath us (a refetch after an edit, a deletion...)
      if (st.count !== st.ackCount) {
        st.ackCount = st.count;
        if (st.last > st.first) refreshRange(st);
      }

      // pages in range but missing from the cache (cache reset after a scan,
      // eviction): fetch them again
      if (
        !st.refreshing &&
        st.inflight.size === 0 &&
        !st.error &&
        (run.first > st.first || run.last < st.last) &&
        filter.currentPage >= st.first &&
        filter.currentPage <= st.last
      ) {
        refreshRange(st);
      }
    });

    // --- registry ---------------------------------------------------------

    const regRef = React.useRef(null);
    React.useLayoutEffect(() => {
      if (!enabled) return undefined;
      const reg = {
        name,
        mode,
        st,
        perPage: st.perPage,
        count: st.count,
        run,
        itemCount: items.length,
        selectedCount: 0,
        viewPage: undefined,
        scrollToPage: (p) => {
          scrollToPage(p);
          if (urlDrivenList(S.location.search, S.filter)) setAddressBarPage(p);
        },
      };
      regRef.current = reg;
      activeLists.add(reg);
      const container = containerRef.current && containerRef.current.closest(".item-list-container");
      if (container) container.classList.add("isc-active");
      notifyRegistry();
      return () => {
        activeLists.delete(reg);
        regRef.current = null;
        if (container) container.classList.remove("isc-active");
        notifyRegistry();
      };
    }, [enabled, st]);

    React.useLayoutEffect(() => {
      const reg = regRef.current;
      if (!reg) return;
      const sel = props.selectedIds ? props.selectedIds.size : 0;
      if (
        reg.count !== st.count ||
        reg.run.first !== run.first ||
        reg.run.last !== run.last ||
        reg.itemCount !== items.length ||
        reg.mode !== mode ||
        reg.selectedCount !== sel
      ) {
        Object.assign(reg, { count: st.count, run, itemCount: items.length, mode, selectedCount: sel });
        notifyRegistry();
      }
    });

    // --- scrolling -----------------------------------------------------------

    React.useEffect(() => {
      if (!enabled) return undefined;
      let frame = 0;
      let upIntent = 0;
      let lastSave = 0;

      const check = () => {
        frame = 0;
        const { st: s, run: r, items: its, filter: f } = S;
        const container = containerRef.current;
        if (!s || !container || container.offsetParent === null) return;
        const vh = window.innerHeight;
        const total = totalPages(s);
        const bottom = sentinelRef.current;
        const top = topRef.current;
        const scroller = getScroller(itemElements(container, its.length));
        let nearBottom;
        let nearTop;
        if (scroller) {
          const below = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
          nearBottom = below < scroller.clientHeight * settings.prefetchScreens;
          nearTop = !!top && scroller.scrollTop < scroller.clientHeight * 0.5;
        } else {
          nearBottom = !!bottom && bottom.getBoundingClientRect().top < vh * (1 + settings.prefetchScreens);
          nearTop = !!top && top.getBoundingClientRect().bottom > -vh * 0.5;
        }
        const idle = !s.error && !s.refreshing && s.inflight.size === 0;

        // load the next page when the bottom gets close
        if (idle && nearBottom && r.last === s.last && r.last < total) {
          loadPage(s, s.last + 1);
        }

        // load the previous page when the user scrolls up into the top
        if (idle && nearTop && upIntent > Date.now() - 1000 && r.first === s.first) {
          s.holdPosition();
          loadPage(s, s.first - 1);
        }

        if (s.restoring) return;

        // remember the position, and keep the URL's page in step with the view
        const anchor = captureAnchor();
        if (!anchor) return;
        s.anchor = anchor;
        const now = Date.now();
        if (now - lastSave > 400) {
          lastSave = now;
          sessionSet(s.storageKey, anchor);
        }
        const reg = regRef.current;
        if (reg && reg.viewPage !== anchor.page) {
          reg.viewPage = anchor.page;
          notifyRegistry();
        }
        if (anchor.page !== urlPage(window.location.search) && urlDrivenList(S.location.search, f)) {
          setAddressBarPage(anchor.page);
        }
      };

      const schedule = () => {
        if (!frame) frame = window.setTimeout(check, 50);
      };
      // listening on the document in the capture phase also catches scrolling
      // inside elements (scroll events don't bubble)
      const lastY = new WeakMap();
      const onScroll = (e) => {
        const t = e.target;
        const pageScroll = t === document || t === document.documentElement || t === window;
        const key = pageScroll ? document : t;
        const y = pageScroll ? window.scrollY : t.scrollTop;
        // scrolling up toward the top loader; our own restore scrolls don't count
        const ours = performance.now() - lastProgrammaticScroll < 200;
        if (!ours && y < (lastY.has(key) ? lastY.get(key) : y)) upIntent = Date.now();
        lastY.set(key, y);
        schedule();
      };
      const onWheel = (e) => {
        if (e.deltaY < 0) {
          upIntent = Date.now();
          schedule();
        }
      };

      document.addEventListener("scroll", onScroll, { capture: true, passive: true });
      window.addEventListener("resize", schedule, { passive: true });
      window.addEventListener("wheel", onWheel, { passive: true });
      S.schedule = schedule;
      schedule();
      return () => {
        document.removeEventListener("scroll", onScroll, { capture: true });
        window.removeEventListener("resize", schedule);
        window.removeEventListener("wheel", onWheel);
        if (frame) window.clearTimeout(frame);
        S.schedule = undefined;
      };
    }, [enabled]);

    // re-check after each render: a short first page, a finished load...
    React.useEffect(() => {
      if (S.schedule) S.schedule();
    });

    // --- pinned list header ------------------------------------------------

    React.useLayoutEffect(() => {
      if (!enabled || settings.disablePinnedHeader || !containerRef.current) return undefined;
      return pinListHeader(containerRef.current, (bottom) => {
        S.pinBottom = bottom;
      });
    }, [enabled]);

    // --- videos -------------------------------------------------------------

    React.useEffect(() => {
      if (!enabled || !containerRef.current) return undefined;
      return attachVideoManager(containerRef.current);
    }, [enabled]);

    // --- lightbox prefetch ----------------------------------------------------

    React.useEffect(() => {
      if (!enabled || name !== "ImageList") return undefined;
      const timer = window.setInterval(() => {
        const { st: s, items: its, run: r } = S;
        const carousel = document.querySelector(".Lightbox-carousel");
        if (!s || !carousel || carousel.children.length !== its.length) return;
        const m = /(-?\d+(?:\.\d+)?)vw/.exec(carousel.style.left || "");
        const index = m ? Math.round(-parseFloat(m[1]) / 100) : 0;
        if (index >= its.length - 3 && r.last === s.last && r.last < totalPages(s)) loadPage(s, s.last + 1);
      }, 400);
      return () => window.clearInterval(timer);
    }, [enabled, name]);

    React.useEffect(() => () => ctl.destroy(), [ctl]);

    // --- render ---------------------------------------------------------------

    const inner = h(WindowCtx.Provider, { value: ctl }, h(Passthrough, { Original, props: passProps }));
    if (!enabled) return h("div", { className: "isc-list", ref: containerRef }, inner);

    return h(
      "div",
      { className: "isc-list isc-enabled", ref: containerRef, "data-isc-mode": mode },
      h(TopLoader, {
        st,
        run,
        topRef,
        onLoad: () => {
          st.holdPosition();
          loadPage(st, st.first - 1);
        },
      }),
      inner,
      h(Sentinel, {
        st,
        run,
        total: totalPages(st),
        itemCount: items.length,
        sentinelRef,
        onRetry: () => {
          st.error = null;
          if (run.first > st.first || run.last < st.last) refreshRange(st);
          else loadPage(st, st.last + 1);
          notify(st);
        },
      }),
      h(ScrollTopButton, {
        getScroller: () => getScroller(itemElements(containerRef.current, S.items.length)),
      })
    );
  }

  // ---------------------------------------------------------------------------
  // pagination patches

  function PaginationProxy({ props, Original }) {
    useRegistry();
    const reg = matchActiveList(props.itemsPerPage, props.totalItems, props.currentPage);
    if (reg) {
      // the footer pagination is replaced by scrolling; the top one stays as a
      // page jumper unless hidden in settings
      if (props.pagePopupPlacement === "top" || settings.hidePageJumper) return null;
      // it shows the page in view, and loaded pages are scrolled to directly
      const jumper = Object.assign({}, props, {
        currentPage: reg.viewPage || props.currentPage,
        onChangePage: (p) => {
          if (p >= reg.run.first && p <= reg.run.last) reg.scrollToPage(p);
          else props.onChangePage(p);
        },
      });
      return h(Passthrough, { Original, props: jumper });
    }
    return h(Passthrough, { Original, props });
  }

  function PaginationIndexProxy({ props, Original }) {
    useRegistry();
    const intl = Intl.useIntl();
    const reg = props.loading ? undefined : matchActiveList(props.itemsPerPage, props.totalItems, props.currentPage);
    if (!reg) return h(Passthrough, { Original, props });
    // with no pages, the count is just the total
    return h(
      "span",
      { className: "filter-container text-muted paginationIndex center-text" },
      // a pill like the filter tags, so it stays readable over the cards when
      // the header is pinned
      h("span", { className: "isc-count" }, intl.formatNumber(props.totalItems), props.metadataByline)
    );
  }

  // ---------------------------------------------------------------------------
  // tagger: confirm "Scrape All" when it would run on many loaded scenes

  let confirmBypass = false;

  function showConfirm(message, onConfirm) {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const close = () => {
      api.ReactDOM.unmountComponentAtNode(host);
      host.remove();
    };
    const { Modal, Button } = Bootstrap;
    api.ReactDOM.render(
      h(
        Modal,
        { show: true, onHide: close, centered: true },
        h(Modal.Body, null, message),
        h(
          Modal.Footer,
          null,
          h(Button, { variant: "secondary", onClick: close }, "Cancel"),
          h(
            Button,
            {
              variant: "primary",
              onClick: () => {
                close();
                onConfirm();
              },
            },
            "Continue"
          )
        )
      ),
      host
    );
  }

  function installTaggerConfirm() {
    document.addEventListener(
      "click",
      (e) => {
        if (confirmBypass || !e.target || !e.target.closest) return;
        const btn = e.target.closest(".tagger-container-header .d-flex > div.ml-1 > button");
        if (!btn || btn.disabled) return;
        let reg;
        for (const r of activeLists) {
          if (r.name === "SceneList" && r.mode === DisplayMode.Tagger) reg = r;
        }
        if (!reg || reg.selectedCount > 0) return;
        const threshold = settings.taggerConfirmThreshold || reg.perPage;
        if (reg.itemCount <= threshold) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        showConfirm(
          `This will scrape all ${reg.itemCount.toLocaleString()} loaded scenes, not just one page. ` +
            "That sends a request to the scraper for each scene. Continue?",
          () => {
            confirmBypass = true;
            try {
              btn.click();
            } finally {
              confirmBypass = false;
            }
          }
        );
      },
      true
    );
  }

  // ---------------------------------------------------------------------------
  // install

  function lastArg(args) {
    return args[args.length - 1];
  }

  function install() {
    if (!installCachePolicies()) return;

    for (const name of Object.keys(LISTS)) {
      const cfg = LISTS[name];
      api.patch.instead(name, function (props, ...rest) {
        return h(InfiniteList, { name, cfg, props, Original: lastArg(rest) });
      });
    }

    // Windowing is applied per card type rather than on the shared GridCard,
    // so that an off-screen card skips its own (fairly heavy) render as well.
    for (const name of CARD_COMPONENTS) {
      api.patch.instead(name, function (props, ...rest) {
        const Original = lastArg(rest);
        const ctl = React.useContext(WindowCtx);
        if (!ctl) return h(Passthrough, { Original, props });
        const id = cardId(props);
        if (id) ctl.latest.set(id, { props, Original });
        return h(MemoWindowedCard, { ctl, id, props, Original });
      });
    }

    api.patch.instead("Pagination", function (props, ...rest) {
      return h(PaginationProxy, { props, Original: lastArg(rest) });
    });

    api.patch.instead("PaginationIndex", function (props, ...rest) {
      return h(PaginationIndexProxy, { props, Original: lastArg(rest) });
    });

    installTaggerConfirm();
    loadSettings();
    if (api.Event && api.Event.addEventListener) {
      api.Event.addEventListener("stash:location", () => loadSettings());
    }
  }

  install();

  // for troubleshooting from the browser console
  window.InfiniteScrollDebug = { store, settings, activeLists, sizeCache };
})();

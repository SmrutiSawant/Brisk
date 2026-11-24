// renderer.js — all the browser logic.
//
// Mental model: each tab is a plain object holding two DOM nodes —
//   .view  a <webview>, which is a full Chromium renderer showing a real page
//   .el    the little tab button up in the tab strip
// Everything else is bookkeeping to keep those two in sync with the toolbar.

// The new tab page ships with the app. Resolved relative to index.html so it
// works no matter where the folder lives on disk.
const NEWTAB = new URL('newtab.html', location.href).href;

// The preload bridge. Guarded so the UI still runs if it's ever missing.
const API = window.browserAPI || {};

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
// A local mirror of what main.js holds. Main is the authority — it validates
// every write and it is what Chromium actually reads — but the UI needs a
// synchronous copy to render the privacy panel and to decide whether to
// upgrade a typed URL.

let settings = {
  searchEngine: 'searxng',
  searxngInstance: 'https://searx.be',
  httpsOnly: true,
  blockThirdPartyCookies: true,
  trimReferrer: true,
  sendGpc: true,
  stripClientHints: true,
  spellcheck: false,
  clearOnExit: false,
  askWhereToSaveDownloads: true,
  blockDangerousDownloads: true,
  dnsMode: 'secure',
  sitePermissions: {},
  showBookmarksBar: true,
};

function setSetting(key, value) {
  settings = { ...settings, [key]: value };
  if (API.setSetting) API.setSetting(key, value);
  renderPrivacyPanel();
}

// ---------------------------------------------------------------------------
// Search engines
// ---------------------------------------------------------------------------
// Two of the three are open source, which is a stronger guarantee than a
// privacy policy: you can read what the thing does, and run it yourself.
//
// SearXNG is a metasearch engine (AGPL) — it forwards your query to other
// engines and merges the results, so no single upstream sees a profile of you.
//
// The catch is instances. SearXNG has no index of its own; it scrapes Google,
// Bing and friends, who aggressively block datacenter IPs. A popular public
// instance gets hammered by bots until every upstream blocks it, and then it
// answers every query with "No results were found" — the instance is up, it
// just has nothing to relay. That is a property of public instances, not a bug
// here, and it is why this is editable from the toolbar rather than hardcoded.
//
// Counter-intuitively, an instance that makes you pass a browser check is
// usually the better bet: the check is what keeps its upstream quota alive,
// and a real browser clears it in a second or two. An instance that lets
// anything straight through is often one whose upstreams have already given up
// on it.
//
// The real fix is self-hosting — your own IP, your own quota. See ROADMAP.md.
const SEARXNG_INSTANCES = [
  'https://searx.be',            // longest-running; browser check
  'https://baresearch.org',      // browser check (Anubis)
  'https://priv.au',
  'https://opnxng.com',
  'https://search.inetol.net',
];

let searxngInstance = SEARXNG_INSTANCES[0];

const SEARCH_ENGINES = [
  {
    id: 'searxng',
    name: 'SearXNG',
    note: 'Open source · merges ~270 engines',
    search: (q) => searxngInstance + '/search?q=' + encodeURIComponent(q),
  },
  {
    id: 'marginalia',
    name: 'Marginalia',
    // Its own crawler and index — not a front end for anyone else's. Tuned
    // for text-heavy non-commercial pages, so it's superb for finding real
    // writing and useless for weather or opening hours. URL format is from
    // its OpenSearch descriptor; note the param is `query`, not `q`.
    note: 'Open source · indie, text-heavy web',
    search: (q) => 'https://marginalia-search.com/search?query=' + encodeURIComponent(q),
  },
  {
    id: 'duckduckgo',
    name: 'DuckDuckGo',
    // Not open source, but reliable and doesn't profile you — the fallback
    // when an instance is having a bad day.
    note: 'Proprietary · general purpose',
    search: (q) => 'https://duckduckgo.com/?q=' + encodeURIComponent(q),
  },
  {
    id: 'google',
    name: 'Google',
    // The widest index there is, and the least private option on the list —
    // it profiles the query and the person making it. Here because sometimes
    // nothing else finds the thing.
    note: 'Proprietary · widest index, tracks you',
    search: (q) => 'https://www.google.com/search?q=' + encodeURIComponent(q),
  },
];

let engineId = SEARCH_ENGINES[0].id;

const engineOf = (id) => SEARCH_ENGINES.find((e) => e.id === id) || SEARCH_ENGINES[0];
const SEARCH = (q) => engineOf(engineId).search(q);

// The new tab page is a separate document with no preload of its own, so the
// chosen engine — and the instance, which it can't otherwise know — ride along
// in the query string. Keep the table in newtab.html in sync with
// SEARCH_ENGINES above.
const homeUrl = () =>
  NEWTAB + '?engine=' + encodeURIComponent(engineId)
         + '&instance=' + encodeURIComponent(searxngInstance);

// Accepts what someone would actually paste: "searx.be", "https://searx.be/",
// "https://searx.be/search", or "http://localhost:8888" for a self-hosted one
// — that last case is the whole point, so it must not be rejected.
// Returns null if it can't be made into an origin.
function normalizeInstance(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : 'https://' + s);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;

    // A hostname with no dot is only meaningful on the local machine.
    if (!u.hostname.includes('.') && u.hostname !== 'localhost') return null;

    return u.origin;   // drops any path, query and trailing slash
  } catch {
    return null;
  }
}

const tabsEl   = document.getElementById('tabs');
const viewsEl  = document.getElementById('views');
const urlInput = document.getElementById('url');
const lockIcon = document.getElementById('lock');
const shieldEl = document.getElementById('shield');
const blockEl  = document.getElementById('blockcount');

const engineBtn  = document.getElementById('engine');
const engineName = document.getElementById('enginename');
const engineMenu = document.getElementById('enginemenu');

const backBtn    = document.getElementById('back');
const forwardBtn = document.getElementById('forward');
const reloadBtn  = document.getElementById('reload');
const homeBtn    = document.getElementById('home');
const newTabBtn  = document.getElementById('newtab');

const panelEl        = document.getElementById('privacypanel');
const extToolbarEl   = document.getElementById('exttoolbar');
const extBtnEl       = document.getElementById('extbtn');
const extCountEl     = document.getElementById('extcount');
const extPanelEl     = document.getElementById('extensionspanel');
const insecureBar    = document.getElementById('insecurebar');
const insecureDetail = document.getElementById('insecuredetail');
const insecureBack   = document.getElementById('insecureback');
const insecureGo     = document.getElementById('insecurego');

const bookmarkBtn         = document.getElementById('bookmarkbtn');
const bookmarksBarEl      = document.getElementById('bookmarksbar');
const bookmarksBarItemsEl = document.getElementById('bookmarksbaritems');
const bookmarksBtn        = document.getElementById('bookmarksbtn');
const bookmarksPanelEl    = document.getElementById('bookmarkspanel');
const bookmarkPopup       = document.getElementById('bookmarkpopup');
const bmPopupTitle        = document.getElementById('bmpopuptitle');
const bmPopupName         = document.getElementById('bmpopupname');
const bmPopupUrl          = document.getElementById('bmpopupurl');
const bmPopupRemove       = document.getElementById('bmpopupremove');
const bmPopupDone         = document.getElementById('bmpopupdone');

const castBtnEl   = document.getElementById('castbtn');
const castDotEl   = document.getElementById('castdot');
const castPanelEl = document.getElementById('castpanel');
const bmContextMenu       = document.getElementById('bmcontextmenu');
const bmCtxOpen           = document.getElementById('bmctxopen');
const bmCtxNewTab         = document.getElementById('bmctxnewtab');
const bmCtxEdit           = document.getElementById('bmctxedit');
const bmCtxDelete         = document.getElementById('bmctxdelete');

let bookmarks = [];
let editingBookmarkId = null;
let contextBookmark = null;
let bookmarkSearchQuery = '';

/** @type {Array<{id:number, view:Element, wrap:Element, el:Element, titleEl:Element, iconEl:Element, url:string, title:string}>} */
let tabs = [];
let activeId = null;
let nextId = 1;
let urlEdited = false; // don't stomp on what the user is typing

// URLs of recently closed tabs, most recent last. Ctrl+Shift+T pops one.
const closedTabs = [];

// ---------------------------------------------------------------------------
// Tracking-parameter stripping
// ---------------------------------------------------------------------------
// None of these change what page you get — they exist only to tell the sender
// who clicked. Firefox strips them; Chrome does not.
//
// Why here and not in main.js: the obvious place would be a webRequest
// .onBeforeRequest redirect, but Electron allows only ONE listener per
// webRequest event per session, and the ad blocker already owns it.
// Registering a second listener would silently disable blocking. So we clean
// URLs at the points where WE start a navigation instead.

const TRACKING_PARAMS = [
  /^utm_/i,            // Google Analytics, near-universal
  /^ga_/i,
  /^fbclid$/i, /^igshid$/i,                 // Meta
  /^gclid$/i, /^dclid$/i, /^gbraid$/i, /^wbraid$/i, /^gclsrc$/i,  // Google Ads
  /^msclkid$/i,                             // Microsoft
  /^twclid$/i, /^ref_src$/i, /^ref_url$/i,  // X/Twitter
  /^ttclid$/i,                              // TikTok
  /^li_fat_id$/i,                           // LinkedIn
  /^yclid$/i,                               // Yandex
  /^epik$/i,                                // Pinterest
  /^mc_eid$/i, /^mc_cid$/i,                 // Mailchimp
  /^_hsenc$/i, /^_hsmi$/i, /^hsCtaTracking$/i,  // HubSpot
  /^mkt_tok$/i,                             // Marketo
  /^vero_id$/i, /^vero_conv$/i,             // Vero
  /^oly_enc_id$/i, /^oly_anon_id$/i,        // Omeda
  /^s_kwcid$/i, /^ef_id$/i,                 // Adobe
  /^icid$/i, /^ncid$/i,
];

function stripTracking(url) {
  try {
    const u = new URL(url);
    // Only touch web URLs — never file:// (the new tab page) or about:.
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return url;

    let changed = false;
    // Snapshot the keys first; deleting while iterating skips entries.
    for (const key of [...u.searchParams.keys()]) {
      if (TRACKING_PARAMS.some((re) => re.test(key))) {
        u.searchParams.delete(key);
        changed = true;
      }
    }
    if (!changed) return url;

    // Drop a now-empty '?' so the address bar stays clean.
    return u.searchParams.toString() ? u.href : u.href.replace(/\?$/, '');
  } catch {
    return url;  // not parseable — leave it alone
  }
}

// ---------------------------------------------------------------------------
// HTTPS-only
// ---------------------------------------------------------------------------
// This lives in BOTH processes, and the reason is a genuine Electron gotcha:
// `will-navigate` — where main.js guards navigation — does not fire for
// navigations started programmatically. Every navigation WE start, from the
// omnibox or by setting a webview's src, is programmatic. So main covers what
// pages do, and this covers what the user does. Miss either half and the
// upgrade silently applies to only some navigations.
//
// Hosts the user chose to load over plain http after an upgrade failed.
// Session-scoped in both processes, populated by the same click, so the two
// copies cannot drift.
const httpsExceptions = new Set();

// Names that never leave this machine. Forcing HTTPS on them would break
// local development for no gain — there is no network in between to listen.
function isLocalHost(hostname) {
  const h = (hostname || '').toLowerCase();
  if (!h) return false;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;
  if (h === '::1' || h.startsWith('127.')) return true;
  if (h.endsWith('.onion')) return true;
  if (/^10\./.test(h) || /^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  return false;
}

// https URL -> the http URL it replaced. Remembered so that if the upgraded
// load fails, we can tell "this site has no HTTPS" apart from "you're
// offline", and offer the original rather than a dead end. Bounded, because
// this would otherwise grow for the life of the session.
const upgradedFrom = new Map();

function upgradeToHttps(url) {
  if (!settings.httpsOnly) return url;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:') return url;
    if (isLocalHost(u.hostname) || httpsExceptions.has(u.hostname)) return url;
    u.protocol = 'https:';

    upgradedFrom.set(u.href, url);
    if (upgradedFrom.size > 50) upgradedFrom.delete(upgradedFrom.keys().next().value);
    return u.href;
  } catch {
    return url;
  }
}

const originalHttpFor = (url) => upgradedFrom.get(url) || null;

// Schemes a tab may be pointed at. Mirrors ALLOWED_SCHEMES in main.js — main
// is the enforcement, this is so the omnibox refuses rather than silently
// doing nothing when you paste `javascript:` or a `data:` URL.
const OMNIBOX_SCHEMES = new Set(['https:', 'http:', 'about:', 'blob:', 'file:', 'chrome-extension:']);

function schemeAllowed(url) {
  if (url.startsWith(NEWTAB)) return true;
  try {
    return OMNIBOX_SCHEMES.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

// Connection-level failures that mean "there is no HTTPS here", as opposed to
// "you are offline". Kept in step with NO_HTTPS_ERRORS in main.js.
const NO_HTTPS_ERRORS = new Set([-100, -101, -102, -107, -118, -200, -201, -202]);

function hostOf(url) {
  try { return new URL(url).hostname || null; } catch { return null; }
}

// ---------------------------------------------------------------------------
// Omnibox: decide whether input is a URL or a search query
// ---------------------------------------------------------------------------

function normalizeUrl(raw) {
  const s = raw.trim();
  if (!s) return null;

  // localhost / bare IP, with optional port. Checked BEFORE the scheme rule,
  // because "localhost:3000" otherwise reads as the scheme "localhost:".
  // upgradeToHttps leaves loopback and private ranges alone but will still
  // upgrade a bare PUBLIC address, which is what you want.
  if (/^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?([/?#]|$)/i.test(s)) {
    return upgradeToHttps('http://' + s);
  }

  // Already has a scheme: about:blank, file:///, https://...
  // The (?!\d) stops "foo:1234" from being mistaken for one.
  if (/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(s)) {
    const url = upgradeToHttps(stripTracking(s));
    // `javascript:` and `data:` in an address bar are how phishing gets a
    // victim to run something on a page they trust. Refuse rather than
    // navigate; main.js blocks them too, but silently.
    return schemeAllowed(url) ? url : null;
  }

  // Looks like a bare domain: example.com, www.foo.co.uk/bar
  // (a space anywhere before the first slash means it's a search)
  if (/^[^\s/?#]+\.[a-z]{2,}([/?#]|$)/i.test(s)) return stripTracking('https://' + s);

  return SEARCH(s);
}

// The address bar stays empty on the new tab page, the way Chrome's does.
function prettyUrl(url) {
  if (!url || url === 'about:blank' || url.startsWith(NEWTAB)) return '';
  return url;
}

// ---------------------------------------------------------------------------
// Ad blocker counter
// ---------------------------------------------------------------------------
// Main sends counts keyed by webContents id; each <webview> reports its own
// via getWebContentsId(), which is how we line them up.

let blockCounts = new Map();

// Permissions a page asked for and was denied, per host, so the privacy panel
// can offer to grant what a site actually wanted rather than listing all
// twenty. Declared up here, beside the other toolbar state, because
// syncShield() reads it and syncShield runs before the panel code below.
const blockedPermissions = new Map();   // host -> Set<permission>

function webContentsIdOf(tab) {
  try { return tab.view.getWebContentsId(); } catch { return null; }
}

function syncShield() {
  const tab = activeTab();
  const wcId = tab ? webContentsIdOf(tab) : null;
  const n = wcId === null ? 0 : (blockCounts.get(wcId) || 0);
  blockEl.textContent = String(n);
  shieldEl.classList.toggle('on', n > 0);

  // A dot, not a dialog. Something was denied and there's a decision waiting
  // in the panel, but the page is never interrupted to say so.
  shieldEl.classList.toggle('attention', hasPendingDecision());
  shieldEl.title = hasPendingDecision()
    ? 'This site asked for a permission and was denied'
    : 'Privacy for this site';
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

function getTab(id) {
  return tabs.find((t) => t.id === id) || null;
}

function activeTab() {
  return getTab(activeId);
}

// The partition name is a contract with main.js: it is the only value
// 'will-attach-webview' will accept, and it is the session main hardens and
// wipes on exit. Change it in one place and private tabs silently fall back
// to the normal jar.
const PRIVATE_PARTITION = 'persist:in-memory-private';

function createTab(url = homeUrl(), { activate = true, isPrivate = false } = {}) {
  const id = nextId++;
  url = upgradeToHttps(stripTracking(url));

  // --- the page itself ---
  const view = document.createElement('webview');
  view.setAttribute('src', url);
  view.setAttribute('allowpopups', '');

  // Normal tabs share one session partition, so logins carry across tabs —
  // which is what people expect from a browser. A private tab gets its own
  // jar instead: separate cookies, separate storage, nothing written to disk,
  // and wiped when the app closes. It cannot see the normal session's logins
  // and the normal session cannot see its.
  if (isPrivate) view.setAttribute('partition', PRIVATE_PARTITION);

  // The wrapper is what gets shown/hidden. Toggling display on the <webview>
  // itself breaks Electron's internal sizing — see the CSS note in index.html.
  const wrap = document.createElement('div');
  wrap.className = 'view-wrap';
  wrap.appendChild(view);
  viewsEl.appendChild(wrap);

  // --- the tab button ---
  const el = document.createElement('div');
  el.className = 'tab' + (isPrivate ? ' private' : '');

  // A private tab is marked twice over — inverted fill AND a mask glyph.
  // Getting this wrong means typing a password into the wrong kind of tab,
  // so one signal isn't enough.
  const mask = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  mask.setAttribute('viewBox', '0 0 24 24');
  mask.setAttribute('class', 'mask');
  const maskPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  maskPath.setAttribute('d', 'M12 4C7 4 3 7.6 1 12c2 4.4 6 8 11 8s9-3.6 11-8c-2-4.4-6-8-11-8zm0 13a5 5 0 1 1 0-10 5 5 0 0 1 0 10zm0-8a3 3 0 1 0 0 6 3 3 0 0 0 0-6z');
  mask.appendChild(maskPath);

  const spinner = document.createElement('div');
  spinner.className = 'spinner';

  const iconEl = document.createElement('img');
  iconEl.className = 'favicon blank';
  iconEl.addEventListener('error', () => iconEl.classList.add('blank'));

  const titleEl = document.createElement('span');
  titleEl.className = 'tab-title';
  titleEl.textContent = 'New tab';

  const closeEl = document.createElement('button');
  closeEl.className = 'tab-close';
  closeEl.textContent = '×';
  closeEl.title = 'Close tab (Ctrl+W)';

  el.append(mask, spinner, iconEl, titleEl, closeEl);
  tabsEl.appendChild(el);

  const tab = {
    id, view, wrap, el, titleEl, iconEl, url,
    title: isPrivate ? 'Private tab' : 'New tab',
    isPrivate,
    // The http URL this tab's current load replaced, if the HTTPS upgrade is
    // what's being tried. Cleared the moment anything succeeds.
    pendingUpgrade: originalHttpFor(url),
    favicon: null,
  };
  titleEl.textContent = tab.title;
  tabs.push(tab);

  // --- wiring ---
  el.addEventListener('mousedown', (e) => {
    if (e.button === 1) { e.preventDefault(); closeTab(id); }  // middle-click closes
    else if (e.button === 0) activateTab(id);
  });
  closeEl.addEventListener('click', (e) => { e.stopPropagation(); closeTab(id); });

  view.addEventListener('page-title-updated', (e) => {
    tab.title = e.title;
    titleEl.textContent = e.title;
    el.title = e.title;
    if (tab.id === activeId) syncCastActiveTab();
  });

  view.addEventListener('page-favicon-updated', (e) => {
    const icon = e.favicons && e.favicons[0];
    if (icon) {
      tab.favicon = icon;
      iconEl.src = icon;
      iconEl.classList.remove('blank');
      const bm = findBookmarkByUrl(tab.url);
      if (bm && !bm.favicon && API.updateBookmark) {
        API.updateBookmark(bm.id, { favicon: icon });
      }
    }
  });

  view.addEventListener('did-start-loading', () => {
    el.classList.add('loading');
    if (id === activeId) syncToolbar();
  });

  view.addEventListener('did-stop-loading', () => {
    el.classList.remove('loading');
    if (id === activeId) syncToolbar();
  });

  const onNavigate = (e) => {
    if (e.url) tab.url = e.url;
    if (id === activeId) {
      urlEdited = false;
      syncToolbar();
      syncCastActiveTab();
    }
  };

  view.addEventListener('did-navigate', (e) => {
    // New page, fresh count. Clear both sides so the toolbar doesn't briefly
    // show the previous page's total.
    const wcId = webContentsIdOf(tab);
    if (wcId !== null) {
      blockCounts.delete(wcId);
      if (API.resetBlockCount) API.resetBlockCount(wcId);
    }

    // A load that succeeded is not a failed upgrade, and permission decisions
    // belong to the page that asked for them.
    tab.pendingUpgrade = originalHttpFor(e.url || '');
    tab.blockedPermissions = new Set();
    if (tab.id === activeId) hideInsecureBar();
    onNavigate(e);
  });

  // In-page navigation (SPA route changes) keeps the same document, so the
  // block count stays.
  view.addEventListener('did-navigate-in-page', (e) => { if (e.isMainFrame) onNavigate(e); });

  view.addEventListener('did-fail-load', (e) => {
    // -3 is ERR_ABORTED, which fires on ordinary redirects/cancels. Ignore it.
    if (e.errorCode === -3 || !e.isMainFrame) return;

    // If the thing that failed was our own silent HTTPS upgrade, say so and
    // offer the choice. Leaving the user on an error page with no explanation
    // is how a good default gets blamed for a broken browser.
    if (tab.pendingUpgrade && NO_HTTPS_ERRORS.has(e.errorCode)) {
      if (tab.id === activeId) showInsecureBar(tab.pendingUpgrade);
      return;
    }

    tab.title = 'Failed to load';
    titleEl.textContent = tab.title;
  });

  if (activate) activateTab(id);
  return tab;
}

function activateTab(id) {
  const tab = getTab(id);
  if (!tab) return;

  activeId = id;
  urlEdited = false;

  for (const t of tabs) {
    const on = t.id === id;
    t.el.classList.toggle('active', on);
    t.wrap.classList.toggle('active', on);
  }
  syncToolbar();
  syncCastActiveTab();
}

function closeTab(id) {
  const idx = tabs.findIndex((t) => t.id === id);
  if (idx === -1) return;

  const [tab] = tabs.splice(idx, 1);

  // Remember where it was so Ctrl+Shift+T can bring it back. An empty new tab
  // page isn't worth restoring, and the list is capped so it can't grow
  // without bound over a long session.
  //
  // A private tab is never remembered. The entire point is that closing it
  // ends the trail; a reopen list that survives it would quietly undo that.
  if (tab.url && !tab.isPrivate && !tab.url.startsWith(NEWTAB)) {
    closedTabs.push(tab.url);
    if (closedTabs.length > 10) closedTabs.shift();
  }

  tab.el.remove();
  tab.wrap.remove();

  if (tabs.length === 0) {
    createTab(homeUrl());            // never leave the window empty
    return;
  }
  if (activeId === id) {
    activateTab(tabs[Math.min(idx, tabs.length - 1)].id);
  }
}

// ---------------------------------------------------------------------------
// Toolbar state
// ---------------------------------------------------------------------------

function syncToolbar() {
  const tab = activeTab();
  if (!tab) return;

  const view = tab.view;
  let loading = false, canBack = false, canFwd = false;

  // These throw if the webview's guest page hasn't attached yet.
  try {
    loading = view.isLoading();
    canBack = view.canGoBack();
    canFwd  = view.canGoForward();
  } catch { /* guest not ready yet — defaults are fine */ }

  backBtn.disabled = !canBack;
  forwardBtn.disabled = !canFwd;
  reloadBtn.title = loading ? 'Stop (Esc)' : 'Reload (Ctrl+R)';

  if (!urlEdited && document.activeElement !== urlInput) {
    urlInput.value = prettyUrl(tab.url);
  }

  // The padlock becomes a warning triangle on plain http. Shape, not colour —
  // the palette is monochrome and shape is colourblind-safe anyway.
  const insecure = !/^https:/i.test(tab.url) && !tab.url.startsWith(NEWTAB);
  lockIcon.classList.toggle('insecure', insecure);
  lockIcon.setAttribute('title', insecure ? 'Not secure — this connection is unencrypted' : 'Secure connection');

  syncShield();
  syncBookmarkStar();
  syncCastButton();
}

function navigate(input) {
  const url = normalizeUrl(input);
  if (!url) return;              // refused: a scheme we won't navigate to
  const tab = activeTab();
  if (!tab) return;

  tab.url = url;
  tab.pendingUpgrade = originalHttpFor(url);
  hideInsecureBar();
  try { tab.view.loadURL(url); } catch { tab.view.setAttribute('src', url); }
  urlEdited = false;
  tab.view.focus();
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

backBtn.addEventListener('click', () => { try { activeTab().view.goBack(); } catch {} });
forwardBtn.addEventListener('click', () => { try { activeTab().view.goForward(); } catch {} });
homeBtn.addEventListener('click', () => navigate(homeUrl()));
newTabBtn.addEventListener('click', () => { createTab(homeUrl()); urlInput.focus(); });

reloadBtn.addEventListener('click', () => {
  const view = activeTab().view;
  try { view.isLoading() ? view.stop() : view.reload(); } catch {}
});

urlInput.addEventListener('input', () => { urlEdited = true; });
urlInput.addEventListener('focus', () => urlInput.select());

urlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); navigate(urlInput.value); }
  if (e.key === 'Escape') { urlEdited = false; syncToolbar(); urlInput.blur(); }
});

// ---------------------------------------------------------------------------
// Keyboard shortcuts
// ---------------------------------------------------------------------------
// One table, two callers. The window listener below catches keys pressed while
// our own UI has focus; main.js catches the ones pressed inside a page — a
// <webview> is a separate process, so its key events never reach us — and
// forwards the action here. Both end up in runAction, so the two paths can't
// drift apart.

const ACTIONS = {
  'new-tab': () => { createTab(homeUrl()); urlInput.focus(); },

  'new-private-tab': () => { createTab(homeUrl(), { isPrivate: true }); urlInput.focus(); },

  'clear-data': () => { if (API.clearBrowsingData) API.clearBrowsingData(); },

  'close-tab': () => {
    if (activeId === null) return;
    closeTab(activeId);
    focusActiveView();   // don't strand focus on the tab that just went away
  },

  'reopen-tab': () => {
    const url = closedTabs.pop();
    if (!url) return;
    createTab(url);
    focusActiveView();
  },

  'focus-omnibox': () => urlInput.focus(),

  'reload': () => { try { activeTab().view.reload(); } catch {} },

  // Ctrl+Shift+R — bypass the cache, the way every other browser does.
  'hard-reload': () => { try { activeTab().view.reloadIgnoringCache(); } catch {} },

  'back':   () => { try { activeTab().view.goBack(); } catch {} },
  'forward':() => { try { activeTab().view.goForward(); } catch {} },

  'cycle-tab': (payload) => {
    if (tabs.length < 2) return;
    const i = tabs.findIndex((t) => t.id === activeId);
    const step = (payload && payload.step) || 1;
    activateTab(tabs[(i + step + tabs.length) % tabs.length].id);
    focusActiveView();   // follow the page you just switched to
  },

  'toggle-bookmark': () => toggleBookmarkCurrentTab(),
  'toggle-bookmarks-bar': () => toggleBookmarksBar(),
  'toggle-cast': () => toggleCastPanel(),
};

// Moving to a different tab should put the caret in that page, so the next
// shortcut arrives through the same route as the last one.
function focusActiveView() {
  const tab = activeTab();
  if (!tab) return;
  try { tab.view.focus(); } catch { /* guest not attached yet */ }
}

function runAction(name, payload) {
  const fn = ACTIONS[name];
  if (fn) fn(payload);
}

// Key combination -> action name, for the UI-has-focus case.
function shortcutFor(e) {
  const ctrl = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();

  if (ctrl && !e.altKey) {
    if (key === 't') return [e.shiftKey ? 'reopen-tab' : 'new-tab'];
    if (key === 'n' && e.shiftKey) return ['new-private-tab'];
    if (key === 'w') return ['close-tab'];
    if (key === 'l') return ['focus-omnibox'];
    if (key === 'r') return [e.shiftKey ? 'hard-reload' : 'reload'];
    if (key === 'd') return ['toggle-bookmark'];
    if (key === 'b' && e.shiftKey) return ['toggle-bookmarks-bar'];
    if (key === 'k' && e.shiftKey) return ['toggle-cast'];
    if (key === 'tab') return ['cycle-tab', { step: e.shiftKey ? -1 : 1 }];
    if (key === 'delete' && e.shiftKey) return ['clear-data'];
  }

  if (e.altKey && !ctrl) {
    if (key === 'arrowleft') return ['back'];
    if (key === 'arrowright') return ['forward'];
    if (key === 'c') return ['toggle-cast'];
  }

  return null;
}

window.addEventListener('keydown', (e) => {
  const hit = shortcutFor(e);
  if (!hit) return;
  e.preventDefault();
  runAction(hit[0], hit[1]);
});

// ---------------------------------------------------------------------------
// Search engine picker
// ---------------------------------------------------------------------------

function renderEngineMenu() {
  engineMenu.textContent = '';

  for (const e of SEARCH_ENGINES) {
    const opt = document.createElement('button');
    opt.className = 'engine-opt' + (e.id === engineId ? ' active' : '');

    // SVG elements need createElementNS and setAttribute — their className is
    // an SVGAnimatedString, not a plain string.
    const tick = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    tick.setAttribute('viewBox', '0 0 24 24');
    tick.setAttribute('class', 'tick');
    const tickPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    tickPath.setAttribute('d', 'M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z');
    tick.appendChild(tickPath);

    const label = document.createElement('span');
    label.className = 'label';
    const name = document.createElement('b');
    name.textContent = e.name;
    const note = document.createElement('small');
    note.textContent = e.note;
    label.append(name, note);

    opt.append(tick, label);
    opt.addEventListener('click', () => { setEngine(e.id); closeEngineMenu(); });
    engineMenu.appendChild(opt);

    // The instance editor belongs to SearXNG and only makes sense when it's
    // the engine in use, so it hangs off that row rather than sitting in a
    // separate settings screen.
    if (e.id === 'searxng' && engineId === 'searxng') {
      engineMenu.appendChild(buildInstanceEditor());
    }
  }
}

function buildInstanceEditor() {
  const box = document.createElement('div');
  box.className = 'instance';

  const field = document.createElement('input');
  field.type = 'text';
  field.spellcheck = false;
  field.value = searxngInstance;
  field.setAttribute('aria-label', 'SearXNG instance');

  const commit = () => {
    if (setInstance(field.value)) field.value = searxngInstance;
    else field.value = searxngInstance;   // rejected — show what's still in use
  };
  field.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); commit(); field.blur(); }
    if (ev.key === 'Escape') { field.value = searxngInstance; field.blur(); }
  });
  field.addEventListener('blur', commit);

  const chips = document.createElement('div');
  chips.className = 'chips';
  for (const url of SEARXNG_INSTANCES) {
    const chip = document.createElement('button');
    chip.className = 'chip' + (url === searxngInstance ? ' active' : '');
    chip.textContent = url.replace(/^https?:\/\//, '');
    chip.addEventListener('click', () => {
      setInstance(url);
      renderEngineMenu();
    });
    chips.appendChild(chip);
  }

  const hint = document.createElement('small');
  hint.textContent = 'No results on every query? The instance is up but its '
    + 'upstreams have blocked it. Try another.';

  box.append(field, chips, hint);
  return box;
}

// Re-point any open new tab page, whose search form was built from the old
// engine or instance and is now stale.
function refreshNewTabPages() {
  const url = homeUrl();
  for (const t of tabs) {
    if (!t.url.startsWith(NEWTAB)) continue;
    t.url = url;
    try { t.view.loadURL(url); } catch { /* guest not ready; it'll be right next time */ }
  }
}

function setEngine(id) {
  engineId = engineOf(id).id;
  const engine = engineOf(engineId);

  engineName.textContent = engine.name;
  urlInput.placeholder = 'Search ' + engine.name + ' or type a URL';
  if (API.setSetting) API.setSetting('searchEngine', engineId);

  renderEngineMenu();
  refreshNewTabPages();
}

function setInstance(raw) {
  const origin = normalizeInstance(raw);
  if (!origin || origin === searxngInstance) return Boolean(origin);

  searxngInstance = origin;
  if (API.setSetting) API.setSetting('searxngInstance', origin);
  refreshNewTabPages();
  return true;
}

function closeEngineMenu() { engineMenu.classList.remove('open'); }

engineBtn.addEventListener('click', (e) => {
  e.stopPropagation();          // don't let the window handler close it again
  closePrivacyPanel();
  closeExtensionsPanel();
  closeBookmarkPopup();
  closeBookmarksPanel();
  closeBookmarkContextMenu();
  closeCastPanel();
  engineMenu.classList.toggle('open');
});

// Clicks inside the menu keep it open — otherwise typing in the instance field
// would dismiss it on the first keystroke. Choosing an engine closes it
// explicitly, in that option's own handler.
engineMenu.addEventListener('click', (e) => e.stopPropagation());

// Any click elsewhere, or Escape, dismisses it.
window.addEventListener('click', closeEngineMenu);
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeEngineMenu(); });

// ---------------------------------------------------------------------------
// Insecure-connection bar
// ---------------------------------------------------------------------------
// Shown only when the silent HTTPS upgrade failed because the site genuinely
// has none. A bar over the top of the page area rather than a full-page
// interstitial: interstitials that block everything train people to click
// through them without reading, which is the opposite of what a warning is
// for.

let insecureUrl = null;

function showInsecureBar(url) {
  insecureUrl = url;
  const host = hostOf(url) || 'This site';
  insecureDetail.textContent =
    host + ' offers no encrypted connection. Anyone on the network between you '
    + 'and it can read and change what you send.';
  insecureBar.classList.add('show');
}

function hideInsecureBar() {
  insecureUrl = null;
  insecureBar.classList.remove('show');
}

insecureBack.addEventListener('click', () => {
  hideInsecureBar();
  const tab = activeTab();
  try {
    if (tab.view.canGoBack()) tab.view.goBack();
    else navigate(homeUrl());
  } catch { navigate(homeUrl()); }
});

insecureGo.addEventListener('click', () => {
  if (!insecureUrl) return;
  const url = insecureUrl;
  const host = hostOf(url);

  // Both processes need the exception: this one so the omnibox stops
  // upgrading, main so page-initiated navigations stop too. One click, two
  // updates, so they cannot disagree.
  if (host) {
    httpsExceptions.add(host);
    if (API.allowInsecure) API.allowInsecure(host);
  }
  hideInsecureBar();

  const tab = activeTab();
  if (!tab) return;
  tab.pendingUpgrade = null;
  tab.url = url;
  try { tab.view.loadURL(url); } catch { tab.view.setAttribute('src', url); }
});

// ---------------------------------------------------------------------------
// Privacy panel
// ---------------------------------------------------------------------------
// Every strict default the browser ships with is switchable here. That is what
// separates a defensible default from a merely opinionated one: the user can
// always see what is being done on their behalf, and always undo it.

// Keep in step with PERMISSION_LABELS in privacy.js. Blocked permissions
// arrive over IPC carrying their own label; this table is for the ones already
// granted, which are read back from settings and have no message attached.
const PERMISSION_LABELS = {
  geolocation: 'Location',
  notifications: 'Notifications',
  media: 'Camera and microphone',
  'display-capture': 'Screen sharing',
  midi: 'MIDI devices',
  midiSysex: 'MIDI (full device access)',
  'idle-detection': 'Idle detection',
  'clipboard-read': 'Clipboard reading',
  'window-management': 'Window and screen layout',
  'speaker-selection': 'Audio output devices',
  'storage-access': 'Third-party storage',
  'top-level-storage-access': 'Third-party storage',
  mediaKeySystem: 'DRM playback',
  hid: 'HID devices',
  serial: 'Serial ports',
  usb: 'USB devices',
  bluetooth: 'Bluetooth',
  fileSystem: 'Local file access',
  openExternal: 'Opening other apps',
  keyboardLock: 'Keyboard capture',
};

const PROTECTIONS = [
  {
    key: 'httpsOnly',
    name: 'HTTPS-only',
    note: 'Upgrade every site to an encrypted connection, and ask before ever falling back.',
  },
  {
    key: 'blockThirdPartyCookies',
    name: 'Block third-party cookies',
    note: 'The mechanism behind cross-site tracking: one embedded network reading the same cookie everywhere.',
  },
  {
    key: 'trimReferrer',
    name: 'Trim cross-site referrers',
    note: 'Other sites learn you came from here, not which page you were reading.',
  },
  {
    key: 'sendGpc',
    name: 'Send Global Privacy Control',
    note: 'A legally binding opt-out of data sale under California and Colorado law.',
  },
  {
    key: 'stripClientHints',
    name: 'Strip high-entropy Client Hints',
    note: 'Hides your exact CPU, device model and OS build. The low-entropy ones stay — removing those makes you more distinctive, not less.',
  },
  {
    key: 'blockDangerousDownloads',
    name: 'Warn on executable downloads',
    note: 'Ask before a site writes a program to your disk.',
  },
  {
    key: 'askWhereToSaveDownloads',
    name: 'Ask where to save downloads',
    note: 'Nothing lands on disk without you choosing where.',
  },
  {
    key: 'spellcheck',
    name: 'Spellcheck',
    note: 'Off by default: Chromium fetches its dictionaries from a Google server and re-checks periodically.',
  },
  {
    key: 'clearOnExit',
    name: 'Clear everything on exit',
    note: 'Wipe cookies, cache and site storage when the browser closes.',
  },
];

const DNS_MODES = [
  { id: 'secure', label: 'Encrypted only' },
  { id: 'automatic', label: 'Encrypted if possible' },
  { id: 'off', label: 'System DNS' },
];

function activeHost() {
  const tab = activeTab();
  if (!tab || !tab.url || tab.url.startsWith(NEWTAB)) return null;
  return hostOf(tab.url);
}

function hasPendingDecision() {
  const host = activeHost();
  if (!host) return false;
  const blocked = blockedPermissions.get(host);
  return Boolean(blocked && blocked.size);
}

function row({ name, note, on, onClick, className = '' }) {
  const el = document.createElement('button');
  el.className = 'pp-row' + (on ? ' on' : '') + (className ? ' ' + className : '');

  const label = document.createElement('span');
  label.className = 'label';
  const title = document.createElement('span');
  title.textContent = name;
  label.appendChild(title);
  if (note) {
    const small = document.createElement('small');
    small.textContent = note;
    label.appendChild(small);
  }

  const sw = document.createElement('span');
  sw.className = 'sw';

  el.append(label, sw);
  el.addEventListener('click', onClick);
  return el;
}

function section(heading) {
  const el = document.createElement('div');
  el.className = 'pp-section';
  const h = document.createElement('h4');
  h.textContent = heading;
  el.appendChild(h);
  return el;
}

function renderPrivacyPanel() {
  if (!panelEl.classList.contains('open')) return;
  panelEl.textContent = '';

  const tab = activeTab();
  const host = activeHost();
  const wcId = tab ? webContentsIdOf(tab) : null;
  const blocked = wcId === null ? 0 : (blockCounts.get(wcId) || 0);

  // --- header ---
  const head = document.createElement('div');
  head.className = 'pp-head';
  const hostEl = document.createElement('div');
  hostEl.className = 'pp-host';
  hostEl.textContent = host || 'New tab';
  const sub = document.createElement('div');
  sub.className = 'pp-sub';
  sub.textContent = tab && tab.isPrivate
    ? 'Private tab — separate cookies, nothing saved to disk'
    : blocked + (blocked === 1 ? ' request blocked on this page' : ' requests blocked on this page');
  head.append(hostEl, sub);
  panelEl.appendChild(head);

  // --- this site ---
  if (host) {
    const siteSection = section('This site');
    const granted = (settings.sitePermissions || {})[host] || {};
    const asked = blockedPermissions.get(host) || new Set();
    const names = new Set([...Object.keys(granted), ...asked]);

    if (names.size === 0) {
      const empty = document.createElement('div');
      empty.className = 'pp-empty';
      empty.textContent = 'This site has not asked for any device permissions.';
      siteSection.appendChild(empty);
    } else {
      for (const permission of names) {
        const on = granted[permission] === true;
        siteSection.appendChild(row({
          name: PERMISSION_LABELS[permission] || permission,
          note: on ? 'Allowed on this site' : 'Blocked — this site asked for it',
          on,
          onClick: () => {
            const next = { ...(settings.sitePermissions || {}) };
            const site = { ...(next[host] || {}) };
            if (on) delete site[permission];
            else site[permission] = true;
            if (Object.keys(site).length) next[host] = site;
            else delete next[host];

            settings = { ...settings, sitePermissions: next };
            if (API.setPermission) API.setPermission(host, permission, !on);
            renderPrivacyPanel();
          },
        }));
      }
    }

    if (httpsExceptions.has(host)) {
      siteSection.appendChild(row({
        name: 'Allowed over plain HTTP',
        note: 'This exception lasts until you close the browser.',
        on: true,
        onClick: () => {
          httpsExceptions.delete(host);
          renderPrivacyPanel();
        },
      }));
    }

    panelEl.appendChild(siteSection);
  }

  // --- global protections ---
  const protections = section('Protections');
  for (const p of PROTECTIONS) {
    protections.appendChild(row({
      name: p.name,
      note: p.note,
      on: settings[p.key] === true,
      onClick: () => setSetting(p.key, !settings[p.key]),
    }));
  }
  panelEl.appendChild(protections);

  // --- DNS ---
  const dns = section('Encrypted DNS');
  const dnsNote = document.createElement('div');
  dnsNote.className = 'pp-empty';
  dnsNote.textContent =
    'Plain DNS leaks every hostname you visit to the network even when the '
    + 'page itself is encrypted. "Encrypted only" never falls back — which is '
    + 'the point, but it also means hotel wifi sign-in pages will not load.';
  dns.appendChild(dnsNote);

  const chips = document.createElement('div');
  chips.className = 'pp-select';
  for (const mode of DNS_MODES) {
    const chip = document.createElement('button');
    chip.className = 'chip' + (settings.dnsMode === mode.id ? ' active' : '');
    chip.textContent = mode.label;
    chip.addEventListener('click', () => setSetting('dnsMode', mode.id));
    chips.appendChild(chip);
  }
  dns.appendChild(chips);
  panelEl.appendChild(dns);

  // --- actions ---
  const actions = section('Data');
  actions.appendChild(row({
    name: 'New private tab',
    note: 'Separate cookie jar, nothing written to disk. Ctrl+Shift+N',
    on: false,
    onClick: () => { closePrivacyPanel(); runAction('new-private-tab'); },
  }));
  actions.appendChild(row({
    name: 'Clear browsing data…',
    note: 'Cookies, cache and site storage, everywhere. Ctrl+Shift+Delete',
    on: false,
    onClick: () => { closePrivacyPanel(); runAction('clear-data'); },
  }));
  panelEl.appendChild(actions);
}

function closePrivacyPanel() {
  panelEl.classList.remove('open');
}

shieldEl.addEventListener('click', (e) => {
  e.stopPropagation();
  closeEngineMenu();
  closeExtensionsPanel();
  closeBookmarkPopup();
  closeBookmarksPanel();
  closeBookmarkContextMenu();
  closeCastPanel();
  const opening = !panelEl.classList.contains('open');
  panelEl.classList.toggle('open', opening);
  if (opening) {
    // Opening the panel is the acknowledgement — the dot has done its job.
    const host = activeHost();
    if (host) blockedPermissions.delete(host);
    renderPrivacyPanel();
    syncShield();
  }
});

panelEl.addEventListener('click', (e) => e.stopPropagation());
window.addEventListener('click', closePrivacyPanel);
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePrivacyPanel(); });

// ---------------------------------------------------------------------------
// Extensions
// ---------------------------------------------------------------------------
let extensions = [];

function closeExtensionsPanel() {
  if (extPanelEl) extPanelEl.classList.remove('open');
  if (extBtnEl) extBtnEl.classList.remove('active');
}

function openExtensionsPanel() {
  closePrivacyPanel();
  closeEngineMenu();
  if (extPanelEl) extPanelEl.classList.add('open');
  if (extBtnEl) extBtnEl.classList.add('active');
  renderExtensions();
}

function renderExtensions() {
  if (!extPanelEl || !extBtnEl || !extToolbarEl) return;
  const count = extensions.length;
  extCountEl.textContent = String(count);
  extBtnEl.classList.toggle('has-extensions', count > 0);

  // Pinned items in toolbar
  extToolbarEl.textContent = '';
  const pinned = extensions.filter((e) => e.pinned);
  for (const ext of pinned) {
    const btn = document.createElement('button');
    btn.className = 'ext-pinned-btn';
    btn.title = ext.name + (ext.version ? ` (${ext.version})` : '');
    if (ext.icon) {
      const img = document.createElement('img');
      img.src = ext.icon;
      img.alt = ext.name;
      btn.appendChild(img);
    } else {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      p.setAttribute(
        'd',
        'M20.5 11H19V7c0-1.1-.9-2-2-2h-4V3.5a2.5 2.5 0 0 0-5 0V5H4c-1.1 0-1.99.9-1.99 2v3.8H3.5c1.49 0 2.7 1.21 2.7 2.7s-1.21 2.7-2.7 2.7H2V20c0 1.1.9 2 2 2h3.8v-1.5c0-1.49 1.21-2.7 2.7-2.7s2.7 1.21 2.7 2.7V22H17c1.1 0 2-.9 2-2v-4h1.5a2.5 2.5 0 0 0 0-5z'
      );
      svg.appendChild(p);
      btn.appendChild(svg);
    }
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (ext.popupUrl) {
        createTab(ext.popupUrl);
      } else if (ext.optionsUrl) {
        createTab(ext.optionsUrl);
      } else {
        openExtensionsPanel();
      }
    });
    extToolbarEl.appendChild(btn);
  }

  // Panel content
  extPanelEl.textContent = '';

  const head = document.createElement('div');
  head.className = 'ext-panel-head';
  head.innerHTML = `
    <span class="ext-panel-title">Extensions</span>
    <span class="ext-panel-count">${count} installed</span>
  `;
  extPanelEl.appendChild(head);

  const errorEl = document.createElement('div');
  errorEl.className = 'ext-error';
  extPanelEl.appendChild(errorEl);

  const listEl = document.createElement('div');
  listEl.className = 'ext-list';

  if (count === 0) {
    const empty = document.createElement('div');
    empty.className = 'ext-empty';
    empty.innerHTML = `
      <svg viewBox="0 0 24 24"><path d="M20.5 11H19V7c0-1.1-.9-2-2-2h-4V3.5a2.5 2.5 0 0 0-5 0V5H4c-1.1 0-1.99.9-1.99 2v3.8H3.5c1.49 0 2.7 1.21 2.7 2.7s-1.21 2.7-2.7 2.7H2V20c0 1.1.9 2 2 2h3.8v-1.5c0-1.49 1.21-2.7 2.7-2.7s2.7 1.21 2.7 2.7V22H17c1.1 0 2-.9 2-2v-4h1.5a2.5 2.5 0 0 0 0-5z"/></svg>
      <b>No extensions loaded</b>
      <small>Load an unpacked extension directory containing <code>manifest.json</code>.</small>
    `;
    listEl.appendChild(empty);
  } else {
    for (const ext of extensions) {
      const item = document.createElement('div');
      item.className = 'ext-item';

      const mainRow = document.createElement('div');
      mainRow.className = 'ext-item-main';

      if (ext.icon) {
        const icon = document.createElement('img');
        icon.className = 'ext-item-icon';
        icon.src = ext.icon;
        mainRow.appendChild(icon);
      } else {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('class', 'ext-item-icon-svg');
        const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        p.setAttribute(
          'd',
          'M20.5 11H19V7c0-1.1-.9-2-2-2h-4V3.5a2.5 2.5 0 0 0-5 0V5H4c-1.1 0-1.99.9-1.99 2v3.8H3.5c1.49 0 2.7 1.21 2.7 2.7s-1.21 2.7-2.7 2.7H2V20c0 1.1.9 2 2 2h3.8v-1.5c0-1.49 1.21-2.7 2.7-2.7s2.7 1.21 2.7 2.7V22H17c1.1 0 2-.9 2-2v-4h1.5a2.5 2.5 0 0 0 0-5z'
        );
        svg.appendChild(p);
        mainRow.appendChild(svg);
      }

      const details = document.createElement('div');
      details.className = 'ext-item-details';

      const nameRow = document.createElement('div');
      nameRow.className = 'ext-item-name-row';

      const name = document.createElement('span');
      name.className = 'ext-item-name';
      name.textContent = ext.name;
      nameRow.appendChild(name);

      const ver = document.createElement('span');
      ver.className = 'ext-item-ver';
      ver.textContent = `v${ext.version}`;
      nameRow.appendChild(ver);

      details.appendChild(nameRow);

      if (ext.description) {
        const desc = document.createElement('span');
        desc.className = 'ext-item-desc';
        desc.textContent = ext.description;
        details.appendChild(desc);
      }

      mainRow.appendChild(details);
      item.appendChild(mainRow);

      // Actions row
      const actions = document.createElement('div');
      actions.className = 'ext-item-actions';

      if (ext.popupUrl) {
        const popupBtn = document.createElement('button');
        popupBtn.className = 'ext-action-btn';
        popupBtn.textContent = 'Popup';
        popupBtn.title = 'Open extension popup';
        popupBtn.addEventListener('click', () => {
          closeExtensionsPanel();
          createTab(ext.popupUrl);
        });
        actions.appendChild(popupBtn);
      }

      if (ext.optionsUrl) {
        const optBtn = document.createElement('button');
        optBtn.className = 'ext-action-btn';
        optBtn.textContent = 'Options';
        optBtn.title = 'Open extension options';
        optBtn.addEventListener('click', () => {
          closeExtensionsPanel();
          createTab(ext.optionsUrl);
        });
        actions.appendChild(optBtn);
      }

      const pinBtn = document.createElement('button');
      pinBtn.className = 'ext-action-btn' + (ext.pinned ? ' active' : '');
      pinBtn.title = ext.pinned ? 'Unpin from toolbar' : 'Pin to toolbar';
      pinBtn.innerHTML = `
        <svg viewBox="0 0 24 24"><path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"/></svg>
        ${ext.pinned ? 'Pinned' : 'Pin'}
      `;
      pinBtn.addEventListener('click', async () => {
        if (API.togglePinExtension) {
          const updated = await API.togglePinExtension(ext.id, !ext.pinned);
          if (Array.isArray(updated)) {
            extensions = updated;
            renderExtensions();
          }
        }
      });
      actions.appendChild(pinBtn);

      const removeBtn = document.createElement('button');
      removeBtn.className = 'ext-action-btn danger';
      removeBtn.title = 'Remove extension';
      removeBtn.textContent = 'Remove';
      removeBtn.addEventListener('click', async () => {
        if (API.removeExtension) {
          await API.removeExtension(ext.id);
          extensions = extensions.filter((e) => e.id !== ext.id);
          renderExtensions();
        }
      });
      actions.appendChild(removeBtn);

      item.appendChild(actions);
      listEl.appendChild(item);
    }
  }

  extPanelEl.appendChild(listEl);

  const footer = document.createElement('div');
  footer.className = 'ext-footer';
  const loadBtn = document.createElement('button');
  loadBtn.id = 'load-unpacked-btn';
  loadBtn.className = 'ext-load-btn';
  loadBtn.innerHTML = `
    <svg viewBox="0 0 24 24"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
    Load unpacked extension...
  `;
  loadBtn.addEventListener('click', async () => {
    errorEl.classList.remove('show');
    errorEl.textContent = '';
    if (API.loadUnpackedExtension) {
      const res = await API.loadUnpackedExtension();
      if (res && res.error) {
        errorEl.textContent = res.error;
        errorEl.classList.add('show');
      } else if (res && res.success && res.extension) {
        const existingIdx = extensions.findIndex((e) => e.id === res.extension.id);
        if (existingIdx >= 0) extensions[existingIdx] = res.extension;
        else extensions.push(res.extension);
        renderExtensions();
      }
    }
  });
  footer.appendChild(loadBtn);
  extPanelEl.appendChild(footer);
}

if (extBtnEl) {
  extBtnEl.addEventListener('click', (e) => {
    e.stopPropagation();
    closePrivacyPanel();
    closeEngineMenu();
    closeBookmarkPopup();
    closeBookmarksPanel();
    closeBookmarkContextMenu();
    closeCastPanel();
    const opening = !extPanelEl.classList.contains('open');
    extPanelEl.classList.toggle('open', opening);
    extBtnEl.classList.toggle('active', opening);
    if (opening) renderExtensions();
  });
}

if (extPanelEl) {
  extPanelEl.addEventListener('click', (e) => e.stopPropagation());
}
window.addEventListener('click', closeExtensionsPanel);
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeExtensionsPanel(); });

// ---------------------------------------------------------------------------
// Bookmarks
// ---------------------------------------------------------------------------

function normalizeBookmarkUrl(raw) {
  if (!raw) return '';
  try {
    const u = new URL(raw);
    const origin = u.origin.toLowerCase();
    const pathname = u.pathname.replace(/\/+$/, '');
    return origin + pathname + u.search + u.hash;
  } catch {
    return String(raw).trim().replace(/\/+$/, '');
  }
}

function findBookmarkByUrl(url) {
  if (!url) return null;
  const norm = normalizeBookmarkUrl(url);
  return bookmarks.find((b) => normalizeBookmarkUrl(b.url) === norm) || null;
}

function syncBookmarkStar() {
  if (!bookmarkBtn) return;
  const tab = activeTab();
  if (!tab || !tab.url || tab.url.startsWith(NEWTAB)) {
    bookmarkBtn.classList.remove('bookmarked');
    bookmarkBtn.disabled = !tab || !tab.url || tab.url.startsWith(NEWTAB);
    bookmarkBtn.title = 'Bookmark this tab (Ctrl+D)';
    return;
  }
  bookmarkBtn.disabled = false;
  const bm = findBookmarkByUrl(tab.url);
  const isBm = Boolean(bm);
  bookmarkBtn.classList.toggle('bookmarked', isBm);
  bookmarkBtn.title = isBm ? `Edit bookmark for this tab: ${bm.title} (Ctrl+D)` : 'Bookmark this tab (Ctrl+D)';
}

function closeBookmarkPopup() {
  if (bookmarkPopup) bookmarkPopup.classList.remove('open');
  editingBookmarkId = null;
}

function openBookmarkPopup(bookmark, isNew = false) {
  if (!bookmarkPopup || !bookmark) return;
  closePrivacyPanel();
  closeEngineMenu();
  closeExtensionsPanel();
  closeBookmarksPanel();
  closeBookmarkContextMenu();
  closeCastPanel();

  editingBookmarkId = bookmark.id || null;
  bmPopupTitle.textContent = isNew ? 'Bookmark added' : 'Edit bookmark';
  bmPopupName.value = bookmark.title || '';
  bmPopupUrl.value = bookmark.url || '';
  bmPopupRemove.style.display = (bookmark.id || isNew) ? 'inline-block' : 'none';

  if (bookmarkBtn) {
    const rect = bookmarkBtn.getBoundingClientRect();
    bookmarkPopup.style.top = (rect.bottom + 6) + 'px';
    const rightOffset = Math.max(8, window.innerWidth - rect.right - 10);
    bookmarkPopup.style.right = rightOffset + 'px';
  }

  bookmarkPopup.classList.add('open');
  setTimeout(() => {
    bmPopupName.focus();
    bmPopupName.select();
  }, 50);
}

async function saveBookmarkFromPopup() {
  if (!bookmarkPopup) return;
  const title = bmPopupName.value.trim() || 'Untitled';
  const url = bmPopupUrl.value.trim();
  if (!url) {
    closeBookmarkPopup();
    return;
  }

  if (editingBookmarkId && API.updateBookmark) {
    await API.updateBookmark(editingBookmarkId, { title, url });
  } else if (API.addBookmark) {
    await API.addBookmark({ title, url });
  }
  closeBookmarkPopup();
  syncBookmarkStar();
}

async function removeBookmarkFromPopup() {
  if (!bookmarkPopup) return;
  if (editingBookmarkId && API.removeBookmark) {
    await API.removeBookmark(editingBookmarkId);
  } else {
    const tab = activeTab();
    if (tab && tab.url && API.removeBookmark) {
      await API.removeBookmark(tab.url);
    }
  }
  closeBookmarkPopup();
  syncBookmarkStar();
}

async function toggleBookmarkCurrentTab() {
  const tab = activeTab();
  if (!tab || !tab.url || tab.url.startsWith(NEWTAB)) return;

  const existing = findBookmarkByUrl(tab.url);
  if (existing) {
    openBookmarkPopup(existing, false);
  } else {
    if (API.addBookmark) {
      const newBm = await API.addBookmark({
        title: tab.title || tab.url,
        url: tab.url,
        favicon: tab.favicon || null,
      });
      if (newBm) {
        bookmarks.push(newBm);
        syncBookmarkStar();
        renderBookmarksBar();
        openBookmarkPopup(newBm, true);
        return;
      }
    }
    openBookmarkPopup({ title: tab.title, url: tab.url }, true);
  }
}

function toggleBookmarksBar() {
  setSetting('showBookmarksBar', !settings.showBookmarksBar);
  renderBookmarksBar();
  if (bookmarksPanelEl && bookmarksPanelEl.classList.contains('open')) {
    renderBookmarksPanel();
  }
}

function closeBookmarkContextMenu() {
  if (bmContextMenu) bmContextMenu.classList.remove('open');
  contextBookmark = null;
}

function openBookmarkContextMenu(e, bm) {
  if (!bmContextMenu || !bm) return;
  e.preventDefault();
  e.stopPropagation();
  closePrivacyPanel();
  closeEngineMenu();
  closeExtensionsPanel();
  closeBookmarkPopup();
  closeBookmarksPanel();

  contextBookmark = bm;
  bmContextMenu.style.left = Math.min(e.clientX, window.innerWidth - 140) + 'px';
  bmContextMenu.style.top = (e.clientY + 4) + 'px';
  bmContextMenu.classList.add('open');
}

function createFallbackIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.classList.add('bm-item-icon-svg');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z');
  svg.appendChild(path);
  return svg;
}

function renderBookmarksBar() {
  if (!bookmarksBarEl || !bookmarksBarItemsEl) return;
  const show = settings.showBookmarksBar !== false;
  bookmarksBarEl.style.display = show ? 'flex' : 'none';
  document.body.classList.toggle('has-bookmarks-bar', show);
  if (!show) return;

  bookmarksBarItemsEl.textContent = '';
  if (bookmarks.length === 0) {
    const hint = document.createElement('div');
    hint.className = 'bm-empty-hint';
    hint.textContent = 'No bookmarks yet.';
    const addBtn = document.createElement('button');
    addBtn.className = 'bm-empty-btn';
    addBtn.textContent = '+ Bookmark this tab';
    addBtn.addEventListener('click', () => toggleBookmarkCurrentTab());
    hint.appendChild(addBtn);
    bookmarksBarItemsEl.appendChild(hint);
    return;
  }

  for (const bm of bookmarks) {
    const item = document.createElement('button');
    item.className = 'bm-item';
    item.title = `${bm.title}\n${bm.url}`;

    if (bm.favicon) {
      const img = document.createElement('img');
      img.className = 'bm-item-icon';
      img.src = bm.favicon;
      img.addEventListener('error', () => {
        img.replaceWith(createFallbackIcon());
      });
      item.appendChild(img);
    } else {
      item.appendChild(createFallbackIcon());
    }

    const title = document.createElement('span');
    title.className = 'bm-item-title';
    title.textContent = bm.title || 'Untitled';
    item.appendChild(title);

    item.addEventListener('click', (e) => {
      if (e.ctrlKey || e.metaKey) {
        createTab(bm.url);
      } else {
        navigate(bm.url);
      }
    });
    item.addEventListener('mousedown', (e) => {
      if (e.button === 1) {
        e.preventDefault();
        createTab(bm.url);
      }
    });
    item.addEventListener('contextmenu', (e) => {
      openBookmarkContextMenu(e, bm);
    });

    bookmarksBarItemsEl.appendChild(item);
  }
}

function closeBookmarksPanel() {
  if (bookmarksPanelEl) bookmarksPanelEl.classList.remove('open');
  if (bookmarksBtn) bookmarksBtn.classList.remove('active');
}

function openBookmarksPanel() {
  closePrivacyPanel();
  closeEngineMenu();
  closeExtensionsPanel();
  closeBookmarkPopup();
  closeBookmarkContextMenu();
  if (bookmarksPanelEl) bookmarksPanelEl.classList.add('open');
  if (bookmarksBtn) bookmarksBtn.classList.add('active');
  renderBookmarksPanel();
}

function renderBookmarksPanel() {
  if (!bookmarksPanelEl || !bookmarksBtn) return;
  bookmarksPanelEl.textContent = '';

  const count = bookmarks.length;

  const head = document.createElement('div');
  head.className = 'bmp-head';
  head.innerHTML = `
    <span class="bmp-title">Bookmarks</span>
    <span class="bmp-count">${count} bookmark${count === 1 ? '' : 's'}</span>
  `;
  bookmarksPanelEl.appendChild(head);

  const searchWrap = document.createElement('div');
  searchWrap.className = 'bmp-search-wrap';
  const searchInput = document.createElement('input');
  searchInput.className = 'bmp-search';
  searchInput.type = 'text';
  searchInput.placeholder = 'Search bookmarks…';
  searchInput.value = bookmarkSearchQuery;
  searchInput.addEventListener('input', (e) => {
    bookmarkSearchQuery = e.target.value;
    updateBookmarksList(listEl);
  });
  searchWrap.appendChild(searchInput);
  bookmarksPanelEl.appendChild(searchWrap);

  const listEl = document.createElement('div');
  listEl.className = 'bmp-list';
  updateBookmarksList(listEl);
  bookmarksPanelEl.appendChild(listEl);

  const footer = document.createElement('div');
  footer.className = 'bmp-footer';

  const barRow = document.createElement('div');
  barRow.className = 'bmp-footer-row';
  barRow.innerHTML = `<span>Show bookmarks bar</span>`;
  const barToggleBtn = document.createElement('button');
  barToggleBtn.className = 'pp-row' + (settings.showBookmarksBar !== false ? ' on' : '');
  barToggleBtn.style.padding = '0';
  barToggleBtn.style.width = 'auto';
  const sw = document.createElement('div');
  sw.className = 'sw';
  barToggleBtn.appendChild(sw);
  barToggleBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleBookmarksBar();
  });
  barRow.appendChild(barToggleBtn);
  footer.appendChild(barRow);

  const addBtn = document.createElement('button');
  addBtn.className = 'bmp-add-btn';
  addBtn.innerHTML = `
    <svg viewBox="0 0 24 24"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
    Bookmark current tab
  `;
  addBtn.addEventListener('click', () => {
    closeBookmarksPanel();
    toggleBookmarkCurrentTab();
  });
  footer.appendChild(addBtn);

  bookmarksPanelEl.appendChild(footer);
}

function updateBookmarksList(listEl) {
  listEl.textContent = '';
  const q = bookmarkSearchQuery.toLowerCase().trim();
  const filtered = q
    ? bookmarks.filter((b) => (b.title || '').toLowerCase().includes(q) || (b.url || '').toLowerCase().includes(q))
    : bookmarks;

  if (filtered.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'bmp-empty';
    empty.textContent = q ? 'No matching bookmarks' : 'No bookmarks yet';
    listEl.appendChild(empty);
    return;
  }

  for (const bm of filtered) {
    const row = document.createElement('div');
    row.className = 'bmp-item';

    if (bm.favicon) {
      const img = document.createElement('img');
      img.className = 'bmp-item-icon';
      img.src = bm.favicon;
      img.addEventListener('error', () => img.replaceWith(createFallbackIcon()));
      row.appendChild(img);
    } else {
      row.appendChild(createFallbackIcon());
    }

    const info = document.createElement('div');
    info.className = 'bmp-item-info';
    const title = document.createElement('span');
    title.className = 'bmp-item-title';
    title.textContent = bm.title || 'Untitled';
    const url = document.createElement('span');
    url.className = 'bmp-item-url';
    try { url.textContent = new URL(bm.url).hostname; } catch { url.textContent = bm.url; }
    info.append(title, url);
    row.appendChild(info);

    const actions = document.createElement('div');
    actions.className = 'bmp-item-actions';

    const openTabBtn = document.createElement('button');
    openTabBtn.className = 'bmp-icon-btn';
    openTabBtn.title = 'Open in new tab';
    openTabBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M19 19H5V5h7V3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z"/></svg>';
    openTabBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeBookmarksPanel();
      createTab(bm.url);
    });

    const editBtn = document.createElement('button');
    editBtn.className = 'bmp-icon-btn';
    editBtn.title = 'Edit bookmark';
    editBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34a.9959.9959 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>';
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeBookmarksPanel();
      openBookmarkPopup(bm, false);
    });

    const delBtn = document.createElement('button');
    delBtn.className = 'bmp-icon-btn danger';
    delBtn.title = 'Delete bookmark';
    delBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>';
    delBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (API.removeBookmark) {
        await API.removeBookmark(bm.id);
        bookmarks = bookmarks.filter((b) => b.id !== bm.id);
        updateBookmarksList(listEl);
        renderBookmarksBar();
        syncBookmarkStar();
      }
    });

    actions.append(openTabBtn, editBtn, delBtn);
    row.appendChild(actions);

    row.addEventListener('click', () => {
      closeBookmarksPanel();
      navigate(bm.url);
    });

    listEl.appendChild(row);
  }
}

// Bookmark event listeners
if (bookmarkBtn) {
  bookmarkBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleBookmarkCurrentTab();
  });
}

if (bookmarksBtn) {
  bookmarksBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    closePrivacyPanel();
    closeEngineMenu();
    closeExtensionsPanel();
    closeBookmarkPopup();
    closeBookmarkContextMenu();
    closeCastPanel();
    const opening = !bookmarksPanelEl.classList.contains('open');
    bookmarksPanelEl.classList.toggle('open', opening);
    bookmarksBtn.classList.toggle('active', opening);
    if (opening) renderBookmarksPanel();
  });
}

if (bmPopupDone) {
  bmPopupDone.addEventListener('click', (e) => {
    e.stopPropagation();
    saveBookmarkFromPopup();
  });
}

if (bmPopupRemove) {
  bmPopupRemove.addEventListener('click', (e) => {
    e.stopPropagation();
    removeBookmarkFromPopup();
  });
}

if (bmPopupName) {
  bmPopupName.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveBookmarkFromPopup();
    else if (e.key === 'Escape') closeBookmarkPopup();
  });
}

if (bmPopupUrl) {
  bmPopupUrl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveBookmarkFromPopup();
    else if (e.key === 'Escape') closeBookmarkPopup();
  });
}

if (bmCtxOpen) {
  bmCtxOpen.addEventListener('click', () => {
    if (contextBookmark) {
      navigate(contextBookmark.url);
      closeBookmarkContextMenu();
    }
  });
}

if (bmCtxNewTab) {
  bmCtxNewTab.addEventListener('click', () => {
    if (contextBookmark) {
      createTab(contextBookmark.url);
      closeBookmarkContextMenu();
    }
  });
}

if (bmCtxEdit) {
  bmCtxEdit.addEventListener('click', () => {
    if (contextBookmark) {
      const bm = contextBookmark;
      closeBookmarkContextMenu();
      openBookmarkPopup(bm, false);
    }
  });
}

if (bmCtxDelete) {
  bmCtxDelete.addEventListener('click', async () => {
    if (contextBookmark && API.removeBookmark) {
      await API.removeBookmark(contextBookmark.id);
      closeBookmarkContextMenu();
    }
  });
}

if (bookmarkPopup) bookmarkPopup.addEventListener('click', (e) => e.stopPropagation());
if (bookmarksPanelEl) bookmarksPanelEl.addEventListener('click', (e) => e.stopPropagation());
if (bmContextMenu) bmContextMenu.addEventListener('click', (e) => e.stopPropagation());

window.addEventListener('click', () => {
  closeBookmarkPopup();
  closeBookmarksPanel();
  closeBookmarkContextMenu();
  closeCastPanel();
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeBookmarkPopup();
    closeBookmarksPanel();
    closeBookmarkContextMenu();
    closeCastPanel();
  }
});

// ---------------------------------------------------------------------------
// Screen and Tab Casting
// ---------------------------------------------------------------------------

let castStatus = {
  isStreaming: false,
  isPaused: false,
  source: 'screen',
  fps: 30,
  targetFps: 30,
  quality: 75,
  port: 8554,
  url: 'http://127.0.0.1:8554',
  clientCount: 0,
  title: 'Entire Screen',
  uptimeSec: 0,
  totalFramesSent: 0,
  qrSvg: '',
  clients: [],
  devices: [],
};

let castDevices = [];
let isScanningDevices = false;
let showManualIpInput = false;
let castNoticeBanner = null; // { title, message }
let activeCastDeviceId = null;
let selectedCastSource = 'tab'; // 'tab' | 'screen' | 'window'
let selectedQualityPreset = '1080p'; // '1080p' | '60fps' | 'eco'

function syncCastButton() {
  if (!castBtnEl) return;
  const isLive = Boolean(castStatus && castStatus.isStreaming);
  castBtnEl.classList.toggle('streaming', isLive);
  if (castDotEl) castDotEl.style.display = isLive ? 'block' : 'none';

  if (isLive) {
    castBtnEl.title = `Casting ${castStatus.source} (${castStatus.clientCount} viewing) — Alt+C`;
  } else {
    castBtnEl.title = 'Cast screen or tab to other devices (Alt+C)';
  }
}

function syncCastActiveTab() {
  if (!API.setCastActiveTab) return;
  const tab = activeTab();
  if (!tab) return;
  const wcId = webContentsIdOf(tab);
  API.setCastActiveTab({
    tabId: wcId,
    title: tab.title || 'Tab',
    url: tab.url,
  });
}

function closeCastPanel() {
  if (castPanelEl) castPanelEl.classList.remove('open');
  if (castBtnEl) castBtnEl.classList.remove('active');
}

function openCastPanel() {
  closePrivacyPanel();
  closeEngineMenu();
  closeExtensionsPanel();
  closeBookmarkPopup();
  closeBookmarksPanel();
  closeBookmarkContextMenu();
  if (castPanelEl) castPanelEl.classList.add('open');
  if (castBtnEl) castBtnEl.classList.add('active');
  renderCastPanel();

  if (API.getCastStatus) {
    API.getCastStatus().then((status) => {
      if (status) {
        castStatus = status;
        if (Array.isArray(status.devices) && status.devices.length > 0) {
          castDevices = status.devices;
        }
        if (castPanelEl && castPanelEl.classList.contains('open')) renderCastPanel();
      }
    }).catch(() => {});
  }

  if (API.discoverCastDevices) {
    isScanningDevices = true;
    renderCastPanel();
    API.discoverCastDevices().then((list) => {
      isScanningDevices = false;
      if (Array.isArray(list) && list.length > 0) {
        castDevices = list;
      }
      if (castPanelEl && castPanelEl.classList.contains('open')) renderCastPanel();
    }).catch(() => {
      isScanningDevices = false;
      if (castPanelEl && castPanelEl.classList.contains('open')) renderCastPanel();
    });
  }
}

async function toggleCastPanel() {
  if (castPanelEl && castPanelEl.classList.contains('open')) {
    closeCastPanel();
  } else {
    if (!castStatus.isStreaming) {
      selectedCastSource = selectedCastSource || 'tab';
      await applyCastConfig();
    }
    openCastPanel();
  }
}

async function applyCastConfig() {
  let fps = 30;
  let quality = 75;
  if (selectedQualityPreset === '60fps') {
    fps = 60;
    quality = 65;
  } else if (selectedQualityPreset === 'eco') {
    fps = 15;
    quality = 60;
  }

  if (API.startCast) {
    syncCastActiveTab();
    const res = await API.startCast({
      source: selectedCastSource,
      quality,
      fps,
    });
    if (res) castStatus = res;
    syncCastButton();
    renderCastPanel();
  }
}

function renderCastPanel() {
  if (!castPanelEl) return;
  castPanelEl.textContent = '';

  // --- Header ---
  const head = document.createElement('div');
  head.className = 'cp-head';
  const titleWrap = document.createElement('div');
  titleWrap.className = 'cp-title-wrap';

  const title = document.createElement('span');
  title.className = 'cp-title';
  title.textContent = 'Cast to device';

  const badge = document.createElement('span');
  badge.className = 'cp-badge' + (castStatus.isStreaming ? ' live' : '');
  badge.textContent = castStatus.isStreaming
    ? (castStatus.isPaused ? 'Paused' : `LIVE${castStatus.clientCount > 0 ? ` (${castStatus.clientCount})` : ''}`)
    : 'Ready';

  titleWrap.append(title, badge);

  const closeBtn = document.createElement('button');
  closeBtn.className = 'cp-close-btn';
  closeBtn.textContent = '×';
  closeBtn.title = 'Close';
  closeBtn.addEventListener('click', closeCastPanel);

  head.append(titleWrap, closeBtn);
  castPanelEl.appendChild(head);

  // --- Notice Banner (if active) ---
  if (castNoticeBanner) {
    const banner = document.createElement('div');
    banner.className = 'cp-cast-banner';

    const bHead = document.createElement('div');
    bHead.className = 'cp-cast-banner-title';
    const bTitle = document.createElement('span');
    bTitle.textContent = castNoticeBanner.title;
    const bClose = document.createElement('button');
    bClose.className = 'cp-cast-banner-close';
    bClose.textContent = '×';
    bClose.title = 'Dismiss';
    bClose.addEventListener('click', () => {
      castNoticeBanner = null;
      renderCastPanel();
    });
    bHead.append(bTitle, bClose);

    const bMsg = document.createElement('div');
    bMsg.textContent = castNoticeBanner.message;

    banner.append(bHead, bMsg);
    castPanelEl.appendChild(banner);
  }

  // --- Section 1: Source Selection ---
  const sourceSection = document.createElement('div');
  sourceSection.className = 'cp-section';
  const sourceTitle = document.createElement('div');
  sourceTitle.className = 'cp-section-title';
  sourceTitle.textContent = 'What to cast';
  sourceSection.appendChild(sourceTitle);

  const sourceChips = document.createElement('div');
  sourceChips.className = 'cp-source-chips';

  const sources = [
    { id: 'tab', name: 'Active Tab', icon: '<path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V7h14v12z"/>' },
    { id: 'screen', name: 'Entire Screen', icon: '<path d="M20 18c1.1 0 1.99-.9 1.99-2L22 6c0-1.1-.9-2-2-2H4c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2H0v2h24v-2h-4zM4 6h16v10H4V6z"/>' },
    { id: 'window', name: 'Browser Window', icon: '<path d="M19 4H5c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 14H5V8h14v10z"/>' },
  ];

  for (const s of sources) {
    const btn = document.createElement('button');
    btn.className = 'cp-source-btn' + (selectedCastSource === s.id ? ' active' : '');
    btn.innerHTML = `<svg viewBox="0 0 24 24">${s.icon}</svg><span>${s.name}</span>`;
    btn.addEventListener('click', () => {
      selectedCastSource = s.id;
      if (castStatus.isStreaming) {
        applyCastConfig();
      } else {
        renderCastPanel();
      }
    });
    sourceChips.appendChild(btn);
  }
  sourceSection.appendChild(sourceChips);

  // Quality presets row
  const qualityRow = document.createElement('div');
  qualityRow.className = 'cp-quality-row';
  const presets = [
    { id: '1080p', label: '1080p (30fps)' },
    { id: '60fps', label: '720p (60fps)' },
    { id: 'eco', label: 'Eco (15fps)' },
  ];
  for (const p of presets) {
    const chip = document.createElement('button');
    chip.className = 'cp-quality-chip' + (selectedQualityPreset === p.id ? ' active' : '');
    chip.textContent = p.label;
    chip.addEventListener('click', () => {
      selectedQualityPreset = p.id;
      if (castStatus.isStreaming) {
        applyCastConfig();
      } else {
        renderCastPanel();
      }
    });
    qualityRow.appendChild(chip);
  }
  sourceSection.appendChild(qualityRow);

  // Action buttons (Start / Stop / Pause)
  const actionRow = document.createElement('div');
  actionRow.className = 'cp-action-row';

  if (!castStatus.isStreaming) {
    const startBtn = document.createElement('button');
    startBtn.className = 'cp-start-btn';
    startBtn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M8 5v14l11-7z"/></svg> Cast Tab';
    startBtn.addEventListener('click', async () => {
      startBtn.textContent = 'Starting…';
      selectedCastSource = selectedCastSource || 'tab';
      await applyCastConfig();
    });
    actionRow.appendChild(startBtn);
  } else {
    const stopBtn = document.createElement('button');
    stopBtn.className = 'cp-stop-btn';
    stopBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M6 6h12v12H6z"/></svg> Stop Casting';
    stopBtn.addEventListener('click', async () => {
      if (API.stopCast) {
        const res = await API.stopCast();
        if (res) castStatus = res;
        activeCastDeviceId = null;
        castNoticeBanner = null;
        syncCastButton();
        renderCastPanel();
      }
    });
    actionRow.appendChild(stopBtn);

    const pauseBtn = document.createElement('button');
    pauseBtn.className = 'cp-pause-btn';
    pauseBtn.textContent = castStatus.isPaused ? 'Resume' : 'Pause';
    pauseBtn.addEventListener('click', async () => {
      if (API.toggleCastPause) {
        castStatus.isPaused = await API.toggleCastPause();
        renderCastPanel();
      }
    });
    actionRow.appendChild(pauseBtn);
  }
  sourceSection.appendChild(actionRow);
  castPanelEl.appendChild(sourceSection);

  // --- Section 2: Active Viewers (Connected Clients) ---
  if (castStatus.clients && castStatus.clients.length > 0) {
    const viewersSection = document.createElement('div');
    viewersSection.className = 'cp-section';

    const vTitleRow = document.createElement('div');
    vTitleRow.className = 'cp-section-title';
    vTitleRow.innerHTML = `<span>Connected Viewers (${castStatus.clients.length})</span><span class="cp-viewer-pill"><span class="cp-viewer-dot"></span> Streaming</span>`;
    viewersSection.appendChild(vTitleRow);

    const vList = document.createElement('div');
    vList.className = 'cp-viewers-list';

    for (const client of castStatus.clients) {
      const vItem = document.createElement('div');
      vItem.className = 'cp-viewer-item';

      const vInfo = document.createElement('div');
      vInfo.className = 'cp-device-info';

      const vIcon = document.createElement('div');
      vIcon.className = 'cp-device-icon';
      vIcon.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 14H9V8h2v8zm4 0h-2V8h2v8z"/></svg>';

      const vTexts = document.createElement('div');
      vTexts.className = 'cp-device-texts';

      const vName = document.createElement('div');
      vName.className = 'cp-device-name';
      vName.textContent = client.device || 'Connected Client';

      const vMeta = document.createElement('div');
      vMeta.className = 'cp-device-meta';
      vMeta.textContent = `${client.ip} • ${client.protocol || 'WebSocket'}`;

      vTexts.append(vName, vMeta);
      vInfo.append(vIcon, vTexts);
      vItem.appendChild(vInfo);
      vList.appendChild(vItem);
    }

    viewersSection.appendChild(vList);
    castPanelEl.appendChild(viewersSection);
  }

  // --- Section 3: Direct Cast (URL & QR Code) ---
  const connectSection = document.createElement('div');
  connectSection.className = 'cp-section';

  const connectTitle = document.createElement('div');
  connectTitle.className = 'cp-section-title';
  connectTitle.textContent = 'Direct Cast (Phone, TV, Tablet)';
  connectSection.appendChild(connectTitle);

  const card = document.createElement('div');
  card.className = 'cp-connect-card';

  const urlRow = document.createElement('div');
  urlRow.className = 'cp-url-row';

  const urlDisplay = document.createElement('div');
  urlDisplay.className = 'cp-url-display';
  urlDisplay.textContent = castStatus.url || 'http://localhost:8554';
  urlDisplay.title = 'Open this URL on any device connected to the same Wi-Fi';

  const copyBtn = document.createElement('button');
  copyBtn.className = 'cp-copy-btn';
  copyBtn.textContent = 'Copy';
  copyBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(castStatus.url || '').then(() => {
      copyBtn.textContent = 'Copied!';
      copyBtn.classList.add('copied');
      setTimeout(() => {
        copyBtn.textContent = 'Copy';
        copyBtn.classList.remove('copied');
      }, 1800);
    });
  });

  const openBtn = document.createElement('button');
  openBtn.className = 'cp-open-btn';
  openBtn.textContent = 'Open';
  openBtn.title = 'Open receiver in a new tab';
  openBtn.addEventListener('click', () => {
    createTab(castStatus.url);
  });

  urlRow.append(urlDisplay, copyBtn, openBtn);
  card.appendChild(urlRow);

  // Embedded QR Code
  if (castStatus.qrSvg) {
    const qrWrap = document.createElement('div');
    qrWrap.className = 'cp-qr-wrap';
    const qrImg = document.createElement('div');
    qrImg.className = 'cp-qr-svg';
    qrImg.innerHTML = castStatus.qrSvg;
    const svgEl = qrImg.querySelector('svg');
    if (svgEl) {
      svgEl.setAttribute('width', '100%');
      svgEl.setAttribute('height', '100%');
    }
    const caption = document.createElement('div');
    caption.className = 'cp-qr-caption';
    caption.textContent = 'Scan with camera on phone or Smart TV to view stream';
    qrWrap.append(qrImg, caption);
    card.appendChild(qrWrap);
  }
  connectSection.appendChild(card);
  castPanelEl.appendChild(connectSection);

  // --- Section 4: Smart TVs & Cast Devices ---
  const devSection = document.createElement('div');
  devSection.className = 'cp-section';

  const devTitleRow = document.createElement('div');
  devTitleRow.className = 'cp-section-title';
  const devTitleText = document.createElement('span');
  devTitleText.textContent = `Smart TVs & Cast Devices (${castDevices.length})`;

  const devHeaderActions = document.createElement('div');
  devHeaderActions.style.display = 'flex';
  devHeaderActions.style.alignItems = 'center';
  devHeaderActions.style.gap = '6px';

  const addIpToggle = document.createElement('button');
  addIpToggle.className = 'cp-scan-btn';
  addIpToggle.textContent = showManualIpInput ? 'Cancel' : '+ Add IP';
  addIpToggle.title = 'Manually add a TV or device by IP';
  addIpToggle.addEventListener('click', () => {
    showManualIpInput = !showManualIpInput;
    renderCastPanel();
  });

  const scanBtn = document.createElement('button');
  scanBtn.className = 'cp-scan-btn' + (isScanningDevices ? ' scanning' : '');
  scanBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M17.65 6.35A8 8 0 1 0 19.73 14h-2.08A6 6 0 1 1 12 6a5.9 5.9 0 0 1 4.22 1.78L13 11h7V4z"/></svg> <span>Scan</span>';
  scanBtn.addEventListener('click', async () => {
    isScanningDevices = true;
    renderCastPanel();
    if (API.discoverCastDevices) {
      const list = await API.discoverCastDevices();
      if (Array.isArray(list)) castDevices = list;
    }
    isScanningDevices = false;
    renderCastPanel();
  });

  devHeaderActions.append(addIpToggle, scanBtn);
  devTitleRow.append(devTitleText, devHeaderActions);
  devSection.appendChild(devTitleRow);

  // Manual IP input field
  if (showManualIpInput) {
    const addIpBar = document.createElement('div');
    addIpBar.className = 'cp-add-ip-bar';

    const ipInput = document.createElement('input');
    ipInput.className = 'cp-add-ip-input';
    ipInput.placeholder = 'e.g. 192.168.0.100';
    ipInput.type = 'text';

    const ipSubmit = document.createElement('button');
    ipSubmit.className = 'cp-add-ip-submit';
    ipSubmit.textContent = 'Add Device';

    const submitIp = async () => {
      const rawIp = ipInput.value.trim();
      if (!rawIp) return;
      ipSubmit.textContent = 'Scanning…';
      if (API.addCastDeviceIp) {
        const added = await API.addCastDeviceIp(rawIp);
        if (added) {
          const idx = castDevices.findIndex((d) => d.id === added.id || d.ip === added.ip);
          if (idx >= 0) castDevices[idx] = added;
          else castDevices.push(added);
        }
      }
      showManualIpInput = false;
      renderCastPanel();
    };

    ipSubmit.addEventListener('click', submitIp);
    ipInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submitIp();
      else if (e.key === 'Escape') {
        showManualIpInput = false;
        renderCastPanel();
      }
    });

    addIpBar.append(ipInput, ipSubmit);
    devSection.appendChild(addIpBar);
    setTimeout(() => ipInput.focus(), 50);
  }

  const devList = document.createElement('div');
  devList.className = 'cp-devices-list';

  if (castDevices && castDevices.length > 0) {
    for (const dev of castDevices) {
      const item = document.createElement('div');
      item.className = 'cp-device-item';

      const info = document.createElement('div');
      info.className = 'cp-device-info';

      const icon = document.createElement('div');
      icon.className = 'cp-device-icon';
      if (dev.type === 'chromecast') {
        icon.innerHTML = '<svg viewBox="0 0 24 24"><path d="M1 18v3h3c0-1.66-1.34-3-3-3zm0-4v2c2.76 0 5 2.24 5 5h2c0-3.87-3.13-7-7-7zm0-4v2c4.97 0 9 4.03 9 9h2c0-6.08-4.92-11-11-11zm20-7H3c-1.1 0-2 .9-2 2v3h2V5h18v14h-7v2h7c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z"/></svg>';
      } else if (dev.type === 'roku') {
        icon.innerHTML = '<svg viewBox="0 0 24 24"><path d="M20 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 14H4V6h16v12zm-6-6-6-4v8z"/></svg>';
      } else {
        icon.innerHTML = '<svg viewBox="0 0 24 24"><path d="M21 3H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h5v2h8v-2h5c1.1 0 1.99-.9 1.99-2L23 5c0-1.1-.9-2-2-2zm0 14H3V5h18v12z"/></svg>';
      }

      const texts = document.createElement('div');
      texts.className = 'cp-device-texts';
      const name = document.createElement('div');
      name.className = 'cp-device-name';
      name.textContent = dev.name || 'Smart TV';
      const meta = document.createElement('div');
      meta.className = 'cp-device-meta';
      const typeLabel = (dev.type || 'tv').toUpperCase();
      const modelLabel = dev.model && dev.model !== dev.name ? ` • ${dev.model}` : '';
      meta.textContent = `${typeLabel}${modelLabel} • ${dev.ip}`;
      texts.append(name, meta);

      info.append(icon, texts);

      const isDeviceActive = castStatus.isStreaming && (
        (castStatus.activeCastDeviceId && castStatus.activeCastDeviceId === dev.id) ||
        (activeCastDeviceId && activeCastDeviceId === dev.id) ||
        (castStatus.clients && castStatus.clients.some((c) => c.ip === dev.ip))
      );

      const actBtn = document.createElement('button');
      actBtn.className = 'cp-device-action-btn' + (isDeviceActive ? ' active' : '');
      if (isDeviceActive) {
        actBtn.textContent = 'Stop Cast';
        actBtn.style.background = '#ef4444';
        actBtn.style.color = '#ffffff';
        actBtn.style.borderColor = '#dc2626';
        actBtn.title = `Stop casting to ${dev.name}`;
        actBtn.addEventListener('click', async () => {
          actBtn.textContent = 'Stopping…';
          actBtn.disabled = true;
          if (API.stopCast) {
            await API.stopCast();
          }
          activeCastDeviceId = null;
          castNoticeBanner = null;
          syncCastButton();
          renderCastPanel();
        });
      } else if (dev.canDirectPlay) {
        actBtn.textContent = 'Cast to TV';
        actBtn.title = `Directly cast screen to ${dev.name}`;
        actBtn.addEventListener('click', async () => {
          actBtn.textContent = 'Connecting…';
          actBtn.disabled = true;
          if (!castStatus.isStreaming) {
            selectedCastSource = selectedCastSource || 'tab';
            await applyCastConfig();
          }
          if (API.castToDevice) {
            const res = await API.castToDevice(dev.id);
            if (res && res.success) {
              activeCastDeviceId = dev.id;
              actBtn.textContent = 'Casting on TV!';
              castNoticeBanner = {
                title: `Casting to ${dev.name}`,
                message: `Live screen is now casting directly on ${dev.name}!`,
              };
            } else {
              activeCastDeviceId = null;
              actBtn.textContent = 'Failed';
              castNoticeBanner = {
                title: `Cast to ${dev.name}`,
                message: res && res.error ? `Notice: ${res.error}` : 'Could not stream directly to TV. You can also open the URL on the TV browser.',
              };
              setTimeout(() => { actBtn.textContent = 'Cast to TV'; actBtn.disabled = false; }, 3000);
            }
            renderCastPanel();
          }
        });
      } else {
        actBtn.textContent = 'Connect';
        actBtn.title = `Start casting and get connection URL for ${dev.name}`;
        actBtn.addEventListener('click', async () => {
          actBtn.textContent = 'Starting…';
          if (!castStatus.isStreaming) {
            selectedCastSource = selectedCastSource || 'tab';
            await applyCastConfig();
          }
          const streamUrl = castStatus.url || `http://${dev.ip}:8554`;
          try {
            await navigator.clipboard.writeText(streamUrl);
          } catch {}

          actBtn.textContent = 'Ready!';
          castNoticeBanner = {
            title: `Ready for ${dev.name}`,
            message: `Stream is live at ${streamUrl}. Open this URL on ${dev.name}'s browser or receiver (URL copied to clipboard).`,
          };
          renderCastPanel();
        });
      }

      item.append(info, actBtn);
      devList.appendChild(item);
    }
  } else {
    const empty = document.createElement('div');
    empty.className = 'cp-empty-state';
    empty.textContent = 'No Smart TVs detected yet. Click Scan to search your Wi-Fi, or click "+ Add IP" to add manually.';
    devList.appendChild(empty);
  }
  devSection.appendChild(devList);
  castPanelEl.appendChild(devSection);

  // --- Live stats when streaming ---
  if (castStatus.isStreaming) {
    const statsGrid = document.createElement('div');
    statsGrid.className = 'cp-stats-grid';

    const fpsBox = document.createElement('div');
    fpsBox.className = 'cp-stat-box';
    fpsBox.innerHTML = `<div class="cp-stat-val">${castStatus.fps || targetFps}</div><div class="cp-stat-label">FPS</div>`;

    const clientsBox = document.createElement('div');
    clientsBox.className = 'cp-stat-box';
    clientsBox.innerHTML = `<div class="cp-stat-val">${castStatus.clientCount}</div><div class="cp-stat-label">Receivers</div>`;

    const timeBox = document.createElement('div');
    timeBox.className = 'cp-stat-box';
    const mins = String(Math.floor(castStatus.uptimeSec / 60)).padStart(2, '0');
    const secs = String(castStatus.uptimeSec % 60).padStart(2, '0');
    timeBox.innerHTML = `<div class="cp-stat-val">${mins}:${secs}</div><div class="cp-stat-label">Uptime</div>`;

    statsGrid.append(fpsBox, clientsBox, timeBox);
    castPanelEl.appendChild(statsGrid);
  }
}

if (castBtnEl) {
  castBtnEl.addEventListener('click', async (e) => {
    e.stopPropagation();
    closePrivacyPanel();
    closeEngineMenu();
    closeExtensionsPanel();
    closeBookmarkPopup();
    closeBookmarksPanel();
    closeBookmarkContextMenu();

    const wasOpen = castPanelEl.classList.contains('open');
    if (!wasOpen && !castStatus.isStreaming) {
      // Directly start casting the active tab on click!
      selectedCastSource = selectedCastSource || 'tab';
      await applyCastConfig();
    }

    const opening = !wasOpen;
    castPanelEl.classList.toggle('open', opening);
    castBtnEl.classList.toggle('active', opening);
    if (opening) renderCastPanel();
  });
}

if (castPanelEl) {
  castPanelEl.addEventListener('click', (e) => e.stopPropagation());
}

// --- Bridges from the main process ---
if (API.hasTitleBarOverlay) {
  document.body.classList.add('has-overlay');
}
if (API.onOpenNewTab) {
  // target="_blank" links, handed over from the main process.
  API.onOpenNewTab((url) => createTab(url));
}
if (API.onFullScreen) {
  API.onFullScreen((on) => document.body.classList.toggle('fullscreen', on));
}
if (API.onBlockCounts) {
  API.onBlockCounts((counts) => { blockCounts = counts; syncShield(); });
}
if (API.onShortcut) {
  // Pressed while a page had focus. main.js already called preventDefault on
  // the guest's behalf, so there's nothing left to suppress here.
  API.onShortcut((hit) => runAction(hit.action, hit));
}

if (API.onPermissionBlocked) {
  // The page has ALREADY been denied by the time this arrives — main.js does
  // not wait for us. This is only so the toolbar can offer to change it.
  API.onPermissionBlocked(({ host, permission }) => {
    if (!host || !permission) return;
    if (!blockedPermissions.has(host)) blockedPermissions.set(host, new Set());
    blockedPermissions.get(host).add(permission);
    syncShield();
    renderPrivacyPanel();
  });
}

if (API.onHttpsUpgradeFailed) {
  // The page-initiated half of the HTTPS upgrade. The omnibox half is handled
  // by the tab's own did-fail-load, above.
  API.onHttpsUpgradeFailed(({ tabId, url }) => {
    const tab = tabs.find((t) => webContentsIdOf(t) === tabId);
    if (!tab) return;
    tab.pendingUpgrade = url;
    if (tab.id === activeId) showInsecureBar(url);
  });
}

if (API.onSettingsChanged) {
  // Main is the authority: it validates every write and may reject one. Take
  // what it actually stored rather than assuming our optimistic copy won.
  API.onSettingsChanged((saved) => {
    if (saved) settings = { ...settings, ...saved };
    renderPrivacyPanel();
    renderBookmarksBar();
  });
}

if (API.onExtensionsChanged) {
  API.onExtensionsChanged((list) => {
    extensions = list || [];
    renderExtensions();
  });
}

if (API.onBookmarksChanged) {
  API.onBookmarksChanged((list) => {
    bookmarks = list || [];
    renderBookmarksBar();
    syncBookmarkStar();
    if (bookmarksPanelEl && bookmarksPanelEl.classList.contains('open')) {
      renderBookmarksPanel();
    }
  });
}

if (API.onCastStatusChanged) {
  API.onCastStatusChanged((status) => {
    if (status) {
      castStatus = status;
      if (!status.isStreaming) {
        activeCastDeviceId = null;
        castNoticeBanner = null;
      } else if (status.activeCastDeviceId) {
        activeCastDeviceId = status.activeCastDeviceId;
      }
      syncCastButton();
      if (castPanelEl && castPanelEl.classList.contains('open')) {
        renderCastPanel();
      }
    }
  });
}

if (API.onCastDevicesChanged) {
  API.onCastDevicesChanged((devices) => {
    if (Array.isArray(devices)) {
      castDevices = devices;
      if (castPanelEl && castPanelEl.classList.contains('open')) {
        renderCastPanel();
      }
    }
  });
}

// canGoBack()/canGoForward() have no change event, so poll them. Cheap.
setInterval(syncToolbar, 400);

// Settings arrive over IPC, so the first tab waits for them. Opening it
// earlier would bake the default engine into its URL, and the new tab page
// would then disagree with the picker.
(async function init() {
  if (API.getSettings) {
    try {
      const saved = await API.getSettings();
      if (saved) settings = { ...settings, ...saved };
      if (saved && saved.searchEngine) engineId = engineOf(saved.searchEngine).id;
      if (saved && saved.searxngInstance) {
        searxngInstance = normalizeInstance(saved.searxngInstance) || searxngInstance;
      }
    } catch { /* fall back to the defaults */ }
  }
  if (API.getExtensions) {
    try {
      const list = await API.getExtensions();
      extensions = list || [];
      renderExtensions();
    } catch { /* ignore */ }
  }
  if (API.getBookmarks) {
    try {
      const list = await API.getBookmarks();
      bookmarks = list || [];
      renderBookmarksBar();
      syncBookmarkStar();
    } catch { /* ignore */ }
  }
  if (API.getCastStatus) {
    try {
      const status = await API.getCastStatus();
      if (status) castStatus = status;
      syncCastButton();
    } catch {}
  }
  setEngine(engineId);
  createTab(homeUrl());
  urlInput.focus();
})();

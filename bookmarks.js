// bookmarks.js — Bookmarks management for Brisk.
// Handles persistence, validation, querying, and live notifications
// of bookmarks stored in userData/bookmarks.json.

const path = require('path');
const fs = require('fs');

const DEFAULT_BOOKMARKS = [
  {
    id: 'bm_searxng',
    title: 'SearXNG',
    url: 'https://searx.be',
    favicon: null,
    createdAt: 1700000000000,
  },
  {
    id: 'bm_github',
    title: 'GitHub',
    url: 'https://github.com',
    favicon: null,
    createdAt: 1700000001000,
  },
  {
    id: 'bm_wikipedia',
    title: 'Wikipedia',
    url: 'https://wikipedia.org',
    favicon: null,
    createdAt: 1700000002000,
  },
];

function normalizeUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  try {
    const u = new URL(rawUrl);
    const origin = u.origin.toLowerCase();
    const pathname = u.pathname.replace(/\/+$/, '');
    return origin + pathname + u.search + u.hash;
  } catch {
    return String(rawUrl).trim().replace(/\/+$/, '');
  }
}

function isValidBookmarkUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return false;
  try {
    const u = new URL(rawUrl);
    return ['https:', 'http:', 'file:', 'about:'].includes(u.protocol);
  } catch {
    return false;
  }
}

function sanitizeBookmark(bm) {
  if (!bm || typeof bm !== 'object') return null;
  if (!isValidBookmarkUrl(bm.url)) return null;

  const title = typeof bm.title === 'string' && bm.title.trim()
    ? bm.title.trim().slice(0, 300)
    : 'Untitled';

  const favicon = typeof bm.favicon === 'string' && bm.favicon.length < 100000
    ? bm.favicon
    : null;

  const id = typeof bm.id === 'string' && bm.id.trim()
    ? bm.id.trim()
    : 'bm_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);

  const createdAt = typeof bm.createdAt === 'number' && !Number.isNaN(bm.createdAt)
    ? bm.createdAt
    : Date.now();

  return { id, title, url: bm.url.trim(), favicon, createdAt };
}

function createBookmarkManager({ userDataPath, notify }) {
  const storeFile = path.join(userDataPath, 'bookmarks.json');
  let bookmarks = [];

  function loadStore() {
    try {
      if (fs.existsSync(storeFile)) {
        const raw = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
        if (Array.isArray(raw)) {
          bookmarks = raw.map(sanitizeBookmark).filter(Boolean);
          return;
        }
      }
    } catch (err) {
      console.error('[bookmarks] Failed to read bookmarks.json:', err.message);
    }
    // Default initial bookmarks if file doesn't exist
    bookmarks = DEFAULT_BOOKMARKS.map(sanitizeBookmark).filter(Boolean);
    saveStore();
  }

  function saveStore() {
    try {
      fs.writeFileSync(storeFile, JSON.stringify(bookmarks, null, 2), 'utf8');
    } catch (err) {
      console.error('[bookmarks] Failed to write bookmarks.json:', err.message);
    }
  }

  function list() {
    return [...bookmarks];
  }

  function findByUrl(url) {
    const target = normalizeUrl(url);
    if (!target) return null;
    return bookmarks.find((b) => normalizeUrl(b.url) === target) || null;
  }

  function findById(id) {
    return bookmarks.find((b) => b.id === id) || null;
  }

  function add({ title, url, favicon }) {
    if (!isValidBookmarkUrl(url)) return null;
    const existing = findByUrl(url);
    if (existing) {
      if (title && typeof title === 'string') existing.title = title.trim().slice(0, 300);
      if (favicon && typeof favicon === 'string') existing.favicon = favicon;
      saveStore();
      if (notify) notify('bookmarks-changed', list());
      return existing;
    }

    const newBm = sanitizeBookmark({
      id: 'bm_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      title: (title || url || 'Untitled').trim().slice(0, 300),
      url: url.trim(),
      favicon: favicon || null,
      createdAt: Date.now(),
    });

    if (!newBm) return null;
    bookmarks.push(newBm);
    saveStore();
    if (notify) notify('bookmarks-changed', list());
    return newBm;
  }

  function remove(idOrUrl) {
    if (!idOrUrl || typeof idOrUrl !== 'string') return false;
    const initialLen = bookmarks.length;
    const targetNorm = normalizeUrl(idOrUrl);
    bookmarks = bookmarks.filter((b) => b.id !== idOrUrl && normalizeUrl(b.url) !== targetNorm);
    if (bookmarks.length !== initialLen) {
      saveStore();
      if (notify) notify('bookmarks-changed', list());
      return true;
    }
    return false;
  }

  function update(id, patch) {
    if (!id || typeof id !== 'string' || !patch || typeof patch !== 'object') return null;
    const bm = findById(id);
    if (!bm) return null;

    if (patch.title !== undefined) {
      bm.title = String(patch.title || 'Untitled').trim().slice(0, 300);
    }
    if (patch.url !== undefined && isValidBookmarkUrl(patch.url)) {
      bm.url = patch.url.trim();
    }
    if (patch.favicon !== undefined) {
      bm.favicon = typeof patch.favicon === 'string' ? patch.favicon : null;
    }

    saveStore();
    if (notify) notify('bookmarks-changed', list());
    return bm;
  }

  function isBookmarked(url) {
    return Boolean(findByUrl(url));
  }

  return {
    loadSaved: loadStore,
    list,
    add,
    remove,
    update,
    isBookmarked,
    findByUrl,
    findById,
  };
}

module.exports = {
  createBookmarkManager,
  normalizeUrl,
  isValidBookmarkUrl,
};

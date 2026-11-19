// preload.js — the only bridge between the main process and our browser UI.
//
// Deliberately tiny: the UI gets exactly the handful of things it needs from
// main, and nothing more. No Node APIs are exposed, and nothing here accepts a
// channel name from the caller — every channel is a literal in this file, so
// the renderer cannot be talked into sending on one it wasn't given.
//
// Guest pages get NO preload at all (main.js strips it in
// 'will-attach-webview'), so none of this is reachable from a web page.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('browserAPI', {
  // Only Windows paints native caption buttons over our tab strip, so only
  // Windows needs the strip to reserve space for them.
  hasTitleBarOverlay: process.platform === 'win32',

  onOpenNewTab: (callback) => {
    ipcRenderer.on('open-new-tab', (_event, url) => callback(url));
  },

  onFullScreen: (callback) => {
    ipcRenderer.on('fullscreen', (_event, isFullScreen) => callback(isFullScreen));
  },

  // Ad blocker. Counts arrive batched as [[tabId, count], ...] where tabId is
  // a webContents id, matched in the renderer via view.getWebContentsId().
  onBlockCounts: (callback) => {
    ipcRenderer.on('block-counts', (_event, entries) => callback(new Map(entries)));
  },

  // Called when a tab navigates, so its counter starts fresh on the new page.
  resetBlockCount: (tabId) => ipcRenderer.send('reset-block-count', tabId),

  // Shortcuts pressed while a page had focus, rescued by the main process.
  onShortcut: (callback) => {
    ipcRenderer.on('shortcut', (_event, payload) => callback(payload));
  },

  // Settings, persisted to a JSON file in userData by the main process.
  // Every value is re-validated there; nothing sent from here is trusted.
  getSettings: () => ipcRenderer.invoke('get-settings'),
  setSetting: (key, value) => ipcRenderer.send('set-setting', key, value),
  onSettingsChanged: (callback) => {
    ipcRenderer.on('settings-changed', (_event, settings) => callback(settings));
  },

  // --- Permissions ---
  // A page asking for the camera is denied before this fires; this is only
  // how the toolbar learns it happened, so it can offer to allow it.
  onPermissionBlocked: (callback) => {
    ipcRenderer.on('permission-blocked', (_event, info) => callback(info));
  },
  // No getter: the renderer already has a validated copy of sitePermissions
  // from get-settings, and every extra channel is extra surface.
  setPermission: (host, permission, allowed) =>
    ipcRenderer.send('set-permission', host, permission, allowed),

  // --- HTTPS-only ---
  // Fires when the silent upgrade to HTTPS failed because the site genuinely
  // has none, so the UI can offer the choice.
  onHttpsUpgradeFailed: (callback) => {
    ipcRenderer.on('https-upgrade-failed', (_event, info) => callback(info));
  },
  allowInsecure: (host) => ipcRenderer.send('allow-insecure', host),

  // --- Data ---
  // Main shows the confirmation dialog; this resolves false if declined.
  clearBrowsingData: () => ipcRenderer.invoke('clear-browsing-data'),

  // --- Extensions ---
  getExtensions: () => ipcRenderer.invoke('get-extensions'),
  loadUnpackedExtension: () => ipcRenderer.invoke('load-unpacked-extension'),
  removeExtension: (id) => ipcRenderer.invoke('remove-extension', id),
  togglePinExtension: (id, pinned) => ipcRenderer.invoke('toggle-pin-extension', id, pinned),
  onExtensionsChanged: (callback) => {
    ipcRenderer.on('extensions-changed', (_event, extensions) => callback(extensions));
  },

  // --- Bookmarks ---
  getBookmarks: () => ipcRenderer.invoke('get-bookmarks'),
  addBookmark: (item) => ipcRenderer.invoke('add-bookmark', item),
  removeBookmark: (idOrUrl) => ipcRenderer.invoke('remove-bookmark', idOrUrl),
  updateBookmark: (id, patch) => ipcRenderer.invoke('update-bookmark', id, patch),
  isBookmarked: (url) => ipcRenderer.invoke('is-bookmarked', url),
  onBookmarksChanged: (callback) => {
    ipcRenderer.on('bookmarks-changed', (_event, bookmarks) => callback(bookmarks));
  },

  // --- Screen & Tab Casting ---
  getCastStatus: () => ipcRenderer.invoke('get-cast-status'),
  getCastSources: () => ipcRenderer.invoke('get-cast-sources'),
  startCast: (options) => ipcRenderer.invoke('start-cast', options),
  stopCast: () => ipcRenderer.invoke('stop-cast'),
  toggleCastPause: () => ipcRenderer.invoke('toggle-cast-pause'),
  discoverCastDevices: () => ipcRenderer.invoke('discover-cast-devices'),
  addCastDeviceIp: (ip) => ipcRenderer.invoke('add-cast-device-ip', ip),
  castToDevice: (deviceId) => ipcRenderer.invoke('cast-to-device', deviceId),
  setCastActiveTab: (info) => ipcRenderer.send('set-cast-active-tab', info),
  onCastStatusChanged: (callback) => {
    ipcRenderer.on('cast-status-changed', (_event, status) => callback(status));
  },
  onCastDevicesChanged: (callback) => {
    ipcRenderer.on('cast-devices-changed', (_event, devices) => callback(devices));
  },
});

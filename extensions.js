// extensions.js — Extension management for Brisk.
// Handles loading unpacked extensions, persistence, and exposing
// extension details (icons, popups, options) to the browser UI.

const { dialog } = require('electron');
const path = require('path');
const fs = require('fs');

function createExtensionManager({ session, userDataPath, notify }) {
  const storeFile = path.join(userDataPath, 'installed-extensions.json');
  let installed = []; // Array of { id, path, pinned, enabled }

  function loadStore() {
    try {
      if (fs.existsSync(storeFile)) {
        installed = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
        if (!Array.isArray(installed)) installed = [];
      }
    } catch (err) {
      console.error('[extensions] Failed to read installed-extensions.json:', err.message);
      installed = [];
    }
  }

  function saveStore() {
    try {
      fs.writeFileSync(storeFile, JSON.stringify(installed, null, 2), 'utf8');
    } catch (err) {
      console.error('[extensions] Failed to write installed-extensions.json:', err.message);
    }
  }

  function getIconDataUrl(extPath, manifest) {
    if (!manifest) return null;
    let iconRel = null;
    const icons =
      manifest.icons ||
      (manifest.action && manifest.action.default_icon) ||
      (manifest.browser_action && manifest.browser_action.default_icon);

    if (typeof icons === 'string') {
      iconRel = icons;
    } else if (icons && typeof icons === 'object') {
      iconRel = icons['48'] || icons['32'] || icons['128'] || icons['16'] || Object.values(icons)[0];
    }
    if (!iconRel) return null;

    try {
      const fullPath = path.resolve(extPath, iconRel);
      if (!fs.existsSync(fullPath)) return null;
      const buf = fs.readFileSync(fullPath);
      const extName = path.extname(fullPath).toLowerCase();
      const mime =
        extName === '.svg'
          ? 'image/svg+xml'
          : extName === '.jpg' || extName === '.jpeg'
          ? 'image/jpeg'
          : 'image/png';
      return `data:${mime};base64,${buf.toString('base64')}`;
    } catch {
      return null;
    }
  }

  function formatExtension(ext, entry = {}) {
    const manifest = ext.manifest || {};
    const popupRel =
      (manifest.action && manifest.action.default_popup) ||
      (manifest.browser_action && manifest.browser_action.default_popup) ||
      null;
    const optionsRel = manifest.options_page || (manifest.options_ui && manifest.options_ui.page) || null;

    return {
      id: ext.id,
      name: ext.name || manifest.name || 'Unnamed Extension',
      version: ext.version || manifest.version || '1.0',
      description: manifest.description || '',
      path: ext.path,
      url: ext.url,
      icon: getIconDataUrl(ext.path, manifest),
      popupUrl: popupRel ? `chrome-extension://${ext.id}/${popupRel}` : null,
      optionsUrl: optionsRel ? `chrome-extension://${ext.id}/${optionsRel}` : null,
      pinned: Boolean(entry.pinned),
      enabled: entry.enabled !== false,
    };
  }

  async function loadSaved() {
    loadStore();
    for (const item of [...installed]) {
      if (!item.path || !fs.existsSync(item.path)) {
        console.warn('[extensions] Path not found for saved extension, skipping:', item.path);
        continue;
      }
      try {
        await session.loadExtension(item.path, { allowFileAccess: true });
        console.log('[extensions] Loaded extension from:', item.path);
      } catch (err) {
        console.error('[extensions] Failed to load extension from', item.path, err.message);
      }
    }
  }

  function list() {
    const all = session.getAllExtensions();
    return all.map((ext) => {
      const entry = installed.find((item) => item.id === ext.id || item.path === ext.path) || {};
      return formatExtension(ext, entry);
    });
  }

  async function loadUnpacked(targetPath) {
    if (!fs.existsSync(targetPath)) {
      throw new Error('Directory does not exist');
    }
    const manifestPath = path.join(targetPath, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
      throw new Error('Folder does not contain a manifest.json file');
    }

    const ext = await session.loadExtension(targetPath, { allowFileAccess: true });
    const existingIndex = installed.findIndex((i) => i.id === ext.id || i.path === ext.path);
    const entry = {
      id: ext.id,
      path: ext.path,
      pinned: existingIndex >= 0 ? installed[existingIndex].pinned : false,
      enabled: true,
    };

    if (existingIndex >= 0) {
      installed[existingIndex] = entry;
    } else {
      installed.push(entry);
    }
    saveStore();

    if (typeof notify === 'function') {
      notify('extensions-changed', list());
    }
    return formatExtension(ext, entry);
  }

  async function promptAndLoadUnpacked(parentWindow) {
    const { canceled, filePaths } = await dialog.showOpenDialog(parentWindow, {
      title: 'Select Unpacked Extension Folder',
      properties: ['openDirectory'],
    });
    if (canceled || !filePaths || !filePaths.length) {
      return { canceled: true };
    }
    try {
      const extension = await loadUnpacked(filePaths[0]);
      return { success: true, extension };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  async function remove(extensionId) {
    try {
      session.removeExtension(extensionId);
    } catch (err) {
      console.warn('[extensions] removeExtension note:', err.message);
    }
    installed = installed.filter((i) => i.id !== extensionId);
    saveStore();

    if (typeof notify === 'function') {
      notify('extensions-changed', list());
    }
    return { success: true };
  }

  function togglePin(extensionId, pinned) {
    const item = installed.find((i) => i.id === extensionId);
    if (item) {
      item.pinned = Boolean(pinned);
    } else {
      installed.push({ id: extensionId, pinned: Boolean(pinned), enabled: true });
    }
    saveStore();

    const currentList = list();
    if (typeof notify === 'function') {
      notify('extensions-changed', currentList);
    }
    return currentList;
  }

  return {
    loadSaved,
    list,
    loadUnpacked,
    promptAndLoadUnpacked,
    remove,
    togglePin,
  };
}

module.exports = { createExtensionManager };

// cast.js — Screen and Tab Casting Engine for Brisk.
// Allows streaming the active tab, entire screen, or browser window to
// other devices on the local network (Smart TVs, phones, tablets, PCs)
// via an embedded zero-latency WebSocket/MJPEG web server, QR code,
// and automatic DLNA/UPnP & Google Cast device discovery.

const { desktopCapturer, screen, webContents } = require('electron');
const http = require('http');
const tls = require('tls');
const dgram = require('dgram');
const os = require('os');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

// Minimal valid 1x1 JFIF JPEG buffer for reliable stream startup & preview fallback
const FALLBACK_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=',
  'base64',
);

// ---------------------------------------------------------------------------
// QR Code Generator (Pure JavaScript, Version 1-5, EC Level M)
// Generates self-contained SVG strings offline with zero dependencies.
// ---------------------------------------------------------------------------

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(function initGf() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x = (x << 1) ^ (x & 128 ? 0x11d : 0);
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();

function gfMul(a, b) {
  return a === 0 || b === 0 ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function rsGenPoly(numEc) {
  let poly = [1];
  for (let i = 0; i < numEc; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= gfMul(poly[j], GF_EXP[i]);
      next[j + 1] ^= poly[j];
    }
    poly = next;
  }
  return poly;
}

function rsEncode(data, numEc) {
  const gen = rsGenPoly(numEc);
  const res = new Uint8Array(numEc);
  for (let i = 0; i < data.length; i++) {
    const factor = data[i] ^ res[0];
    for (let j = 0; j < numEc - 1; j++) {
      res[j] = res[j + 1] ^ gfMul(gen[numEc - 1 - j], factor);
    }
    res[numEc - 1] = gfMul(gen[0], factor);
  }
  return res;
}

const QR_SPECS = [
  { version: 1, size: 21, dataBytes: 16, ecBytes: 10, align: [] },
  { version: 2, size: 25, dataBytes: 28, ecBytes: 16, align: [6, 18] },
  { version: 3, size: 29, dataBytes: 44, ecBytes: 26, align: [6, 22] },
  { version: 4, size: 33, dataBytes: 64, ecBytes: 36, align: [6, 26] },
  { version: 5, size: 37, dataBytes: 86, ecBytes: 48, align: [6, 30] },
];

function generateQRCodeMatrix(text) {
  const textBytes = Buffer.from(text, 'utf8');
  const neededBytes = Math.ceil((12 + textBytes.length * 8 + 4) / 8);
  const spec = QR_SPECS.find((s) => s.dataBytes >= neededBytes) || QR_SPECS[QR_SPECS.length - 1];

  const { version, size, dataBytes: totalDataBytes, ecBytes, align } = spec;

  const bits = [];
  const addBits = (val, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1);
  };
  addBits(4, 4); // Byte mode (0100)
  addBits(Math.min(textBytes.length, totalDataBytes - 2), 8);
  for (let i = 0; i < textBytes.length && bits.length < totalDataBytes * 8 - 4; i++) {
    addBits(textBytes[i], 8);
  }

  const padLen = Math.min(4, totalDataBytes * 8 - bits.length);
  addBits(0, padLen);
  while (bits.length % 8 !== 0) bits.push(0);
  const padBytes = [0xec, 0x11];
  let pIdx = 0;
  while (bits.length < totalDataBytes * 8) {
    addBits(padBytes[pIdx], 8);
    pIdx = (pIdx + 1) % 2;
  }

  const dataCodewords = new Uint8Array(totalDataBytes);
  for (let i = 0; i < totalDataBytes; i++) {
    let byteVal = 0;
    for (let j = 0; j < 8; j++) byteVal = (byteVal << 1) | bits[i * 8 + j];
    dataCodewords[i] = byteVal;
  }

  const ecCodewords = rsEncode(dataCodewords, ecBytes);

  const matrix = Array.from({ length: size }, () => new Array(size).fill(null));
  const isFunction = Array.from({ length: size }, () => new Array(size).fill(false));

  const setModule = (r, c, val, func = true) => {
    matrix[r][c] = val;
    if (func) isFunction[r][c] = true;
  };

  const placeFinder = (row, col) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const nr = row + r;
        const nc = col + c;
        if (nr < 0 || nr >= size || nc < 0 || nc >= size) continue;
        const isBorder = r === -1 || r === 7 || c === -1 || c === 7;
        const isOuter = r === 0 || r === 6 || c === 0 || c === 6;
        const isInner = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        setModule(nr, nc, (!isBorder && (isOuter || isInner)) ? 1 : 0);
      }
    }
  };
  placeFinder(0, 0);
  placeFinder(0, size - 7);
  placeFinder(size - 7, 0);

  if (align.length > 0) {
    for (const r of align) {
      for (const c of align) {
        if (isFunction[r][c]) continue;
        for (let dr = -2; dr <= 2; dr++) {
          for (let dc = -2; dc <= 2; dc++) {
            const isBlack = Math.abs(dr) === 2 || Math.abs(dc) === 2 || (dr === 0 && dc === 0);
            setModule(r + dr, c + dc, isBlack ? 1 : 0);
          }
        }
      }
    }
  }

  for (let i = 8; i < size - 8; i++) {
    if (!isFunction[6][i]) setModule(6, i, i % 2 === 0 ? 1 : 0);
    if (!isFunction[i][6]) setModule(i, 6, i % 2 === 0 ? 1 : 0);
  }

  setModule(4 * version + 9, 8, 1);

  for (let i = 0; i <= 8; i++) {
    if (!isFunction[8][i]) isFunction[8][i] = true;
    if (!isFunction[i][8]) isFunction[i][8] = true;
  }
  for (let i = 0; i < 8; i++) {
    isFunction[8][size - 1 - i] = true;
    isFunction[size - 1 - i][8] = true;
  }

  const allBits = [];
  for (const b of dataCodewords) {
    for (let i = 7; i >= 0; i--) allBits.push((b >> i) & 1);
  }
  for (const b of ecCodewords) {
    for (let i = 7; i >= 0; i--) allBits.push((b >> i) & 1);
  }

  let bitIdx = 0;
  let dir = -1;
  for (let c = size - 1; c > 0; c -= 2) {
    if (c === 6) c--;
    const rows = dir === -1
      ? Array.from({ length: size }, (_, i) => size - 1 - i)
      : Array.from({ length: size }, (_, i) => i);

    for (const r of rows) {
      for (const col of [c, c - 1]) {
        if (!isFunction[r][col]) {
          const bit = bitIdx < allBits.length ? allBits[bitIdx++] : 0;
          matrix[r][col] = bit;
        }
      }
    }
    dir = -dir;
  }

  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (!isFunction[r][c] && (r + c) % 2 === 0) {
        matrix[r][c] ^= 1;
      }
    }
  }

  const formatBits = [1, 0, 1, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0];
  const posA = [
    [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
    [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8],
  ];
  for (let i = 0; i < 15; i++) {
    setModule(posA[i][0], posA[i][1], formatBits[i]);
  }
  const posB = [
    [size - 1, 8], [size - 2, 8], [size - 3, 8], [size - 4, 8], [size - 5, 8], [size - 6, 8], [size - 7, 8],
    [8, size - 8], [8, size - 7], [8, size - 6], [8, size - 5], [8, size - 4], [8, size - 3], [8, size - 2], [8, size - 1],
  ];
  for (let i = 0; i < 15; i++) {
    setModule(posB[i][0], posB[i][1], formatBits[i]);
  }

  return { matrix, size };
}

function generateSvgQr(text, cellSize = 6, margin = 4) {
  try {
    const { matrix, size } = generateQRCodeMatrix(text);
    const totalSize = (size + margin * 2) * cellSize;
    const paths = [];
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (matrix[r][c] === 1) {
          const x = (c + margin) * cellSize;
          const y = (r + margin) * cellSize;
          paths.push(`M${x},${y}h${cellSize}v${cellSize}h-${cellSize}z`);
        }
      }
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalSize} ${totalSize}" width="100%" height="100%"><rect width="100%" height="100%" fill="#ffffff" rx="6"/><path d="${paths.join(' ')}" fill="#111111"/></svg>`;
  } catch (err) {
    console.error('[cast] QR generation failed:', err.message);
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100%" height="100%"><rect width="100%" height="100%" fill="#eeeeee"/><text x="50" y="55" font-size="12" text-anchor="middle" fill="#666">QR Error</text></svg>`;
  }
}

// ---------------------------------------------------------------------------
// Network Helpers
// ---------------------------------------------------------------------------

function getLocalIpAddresses() {
  const ifaces = os.networkInterfaces();
  const list = [];
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const a of addrs) {
      if (a.family === 'IPv4' && !a.internal) {
        // Prioritize Wi-Fi and Ethernet over virtual adapters (e.g. WSL, Docker)
        const isVirtual = /vethernet|docker|virtual|tap|vbox/i.test(name);
        list.push({ name, ip: a.address, isVirtual });
      }
    }
  }
  // Sort so physical Wi-Fi / Ethernet come first
  list.sort((a, b) => (a.isVirtual === b.isVirtual ? 0 : a.isVirtual ? 1 : -1));
  return list;
}

function getPrimaryLocalIp() {
  const ips = getLocalIpAddresses();
  return ips.length > 0 ? ips[0].ip : '127.0.0.1';
}

// ---------------------------------------------------------------------------
// WebSocket Framing (RFC 6455)
// Zero-dependency binary and text frame creation for high-frequency video.
// ---------------------------------------------------------------------------

function createWsFrame(payload, opcode = 0x82) {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
  const len = buf.length;
  let header;

  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = opcode;
    header[1] = len;
  } else if (len <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }

  return Buffer.concat([header, buf]);
}

// ---------------------------------------------------------------------------
// Cast Web Receiver Page (Served to mobile phones, Smart TVs, PCs)
// Responsive theater-mode canvas player with auto-hiding controls and stats.
// ---------------------------------------------------------------------------

function getReceiverHtml(title, serverPort) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no" />
<title>Brisk Cast — ${title || 'Live Screen'}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body {
    width: 100%; height: 100%;
    background: #0d0d0d;
    color: #f0f0f0;
    font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    overflow: hidden;
    user-select: none;
    -webkit-tap-highlight-color: transparent;
  }
  #container {
    position: relative;
    width: 100vw;
    height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #000000;
  }
  #screen {
    max-width: 100%;
    max-height: 100%;
    width: auto;
    height: auto;
    object-fit: contain;
    display: block;
    box-shadow: 0 0 50px rgba(0,0,0,0.8);
  }
  #mjpeg-fallback {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
    display: none;
  }

  /* Header overlay */
  #header {
    position: absolute;
    top: 0; left: 0; right: 0;
    padding: 16px 24px;
    background: linear-gradient(180deg, rgba(0,0,0,0.85) 0%, rgba(0,0,0,0.4) 70%, transparent 100%);
    display: flex;
    align-items: center;
    justify-content: space-between;
    z-index: 10;
    transition: opacity 0.35s ease, transform 0.35s ease;
  }
  #header.autohide {
    opacity: 0;
    transform: translateY(-10px);
    pointer-events: none;
  }

  .brand {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .logo-pill {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    background: #ffffff;
    color: #000000;
    padding: 3px 8px;
    border-radius: 4px;
  }
  .stream-title {
    font-size: 14px;
    font-weight: 600;
    color: #ffffff;
    max-width: 50vw;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .live-badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: rgba(220, 38, 38, 0.2);
    border: 1px solid rgba(239, 68, 68, 0.4);
    color: #ef4444;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.05em;
    padding: 3px 8px;
    border-radius: 12px;
  }
  .live-dot {
    width: 6px; height: 6px;
    background: #ef4444;
    border-radius: 50%;
    animation: pulse 1.4s infinite;
  }
  @keyframes pulse {
    0% { transform: scale(0.95); opacity: 0.6; }
    50% { transform: scale(1.3); opacity: 1; box-shadow: 0 0 8px #ef4444; }
    100% { transform: scale(0.95); opacity: 0.6; }
  }

  .controls {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .stats {
    font-size: 12px;
    color: #a0a0a0;
    font-variant-numeric: tabular-nums;
    background: rgba(255,255,255,0.08);
    padding: 4px 10px;
    border-radius: 6px;
    border: 1px solid rgba(255,255,255,0.1);
  }
  .btn {
    background: rgba(255,255,255,0.12);
    border: 1px solid rgba(255,255,255,0.2);
    color: #ffffff;
    font-size: 13px;
    font-weight: 500;
    padding: 6px 12px;
    border-radius: 6px;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    transition: background 0.15s;
  }
  .btn:hover { background: rgba(255,255,255,0.22); }
  .btn:active { transform: scale(0.97); }

  /* Connecting / Disconnected overlay */
  #overlay {
    position: absolute;
    inset: 0;
    background: rgba(0,0,0,0.85);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 16px;
    z-index: 20;
    transition: opacity 0.3s;
  }
  #overlay.hidden { display: none; }
  .spinner {
    width: 36px; height: 36px;
    border: 3px solid rgba(255,255,255,0.15);
    border-top-color: #ffffff;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .overlay-msg {
    font-size: 16px;
    font-weight: 500;
    color: #ffffff;
  }
  .overlay-sub {
    font-size: 12px;
    color: #888888;
  }
</style>
</head>
<body>
<div id="container">
  <div id="header">
    <div class="brand">
      <span class="logo-pill">Brisk</span>
      <span id="title" class="stream-title">${title || 'Screen Stream'}</span>
      <div class="live-badge"><span class="live-dot"></span> LIVE</div>
    </div>
    <div class="controls">
      <div id="stats" class="stats">Connecting…</div>
      <button id="fsbtn" class="btn" title="Toggle Fullscreen (F)">⛶ Fullscreen</button>
    </div>
  </div>

  <canvas id="screen"></canvas>
  <img id="mjpeg-fallback" alt="Live stream" />

  <div id="overlay">
    <div class="spinner"></div>
    <div id="overlay-title" class="overlay-msg">Connecting to Brisk Cast…</div>
    <div id="overlay-sub" class="overlay-sub">Looking for stream on local network</div>
  </div>
</div>

<script>
  const canvas = document.getElementById('screen');
  const ctx = canvas.getContext('2d');
  const mjpeg = document.getElementById('mjpeg-fallback');
  const header = document.getElementById('header');
  const titleEl = document.getElementById('title');
  const statsEl = document.getElementById('stats');
  const fsBtn = document.getElementById('fsbtn');
  const overlay = document.getElementById('overlay');
  const overlayTitle = document.getElementById('overlay-title');
  const overlaySub = document.getElementById('overlay-sub');

  let ws = null;
  let frameCount = 0;
  let lastFpsTime = performance.now();
  let currentFps = 0;
  let autohideTimer = null;
  let useFallback = false;

  function resetAutohide() {
    header.classList.remove('autohide');
    clearTimeout(autohideTimer);
    autohideTimer = setTimeout(() => {
      header.classList.add('autohide');
    }, 3500);
  }
  window.addEventListener('mousemove', resetAutohide);
  window.addEventListener('touchstart', resetAutohide);
  resetAutohide();

  // Fullscreen
  function toggleFullScreen() {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  }
  fsBtn.addEventListener('click', toggleFullScreen);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'f' || e.key === 'F') toggleFullScreen();
  });
  canvas.addEventListener('dblclick', toggleFullScreen);

  let isDrawingFrame = false;
  let pendingBlob = null;

  function drawNextFrame(blob) {
    if (isDrawingFrame) {
      pendingBlob = blob;
      return;
    }
    isDrawingFrame = true;

    const done = () => {
      isDrawingFrame = false;
      if (pendingBlob) {
        const next = pendingBlob;
        pendingBlob = null;
        drawNextFrame(next);
      }
    };

    if (window.createImageBitmap) {
      createImageBitmap(blob).then((bitmap) => {
        if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
        }
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close();
        done();
      }).catch(() => fallbackDraw(blob, done));
    } else {
      fallbackDraw(blob, done);
    }
  }

  function fallbackDraw(blob, done) {
    const img = new Image();
    const url = URL.createObjectURL(blob);
    img.onload = () => {
      if (canvas.width !== img.naturalWidth || canvas.height !== img.naturalHeight) {
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
      }
      ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      if (done) done();
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      if (done) done();
    };
    img.src = url;
  }

  // WebSocket frame receiver
  function connect() {
    if (useFallback) return startMjpeg();

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = proto + '//' + location.host + '/ws';

    try {
      ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';
    } catch {
      return startMjpeg();
    }

    ws.onopen = () => {
      overlay.classList.add('hidden');
      statsEl.textContent = 'Stream active';
    };

    ws.onmessage = (event) => {
      if (typeof event.data === 'string') {
        try {
          const msg = JSON.parse(event.data);
          if (msg.title) titleEl.textContent = msg.title;
        } catch {}
        return;
      }

      overlay.classList.add('hidden');
      frameCount++;
      const now = performance.now();
      if (now - lastFpsTime >= 1000) {
        currentFps = Math.round((frameCount * 1000) / (now - lastFpsTime));
        frameCount = 0;
        lastFpsTime = now;
        statsEl.textContent = currentFps + ' fps • ' + canvas.width + '×' + canvas.height;
      }

      const blob = new Blob([event.data], { type: 'image/jpeg' });
      drawNextFrame(blob);
    };

    ws.onclose = () => {
      overlay.classList.remove('hidden');
      overlayTitle.textContent = 'Disconnected from host';
      overlaySub.textContent = 'Reconnecting in 2s…';
      setTimeout(connect, 2000);
    };

    ws.onerror = () => {
      startMjpeg();
    };
  }

  function startMjpeg() {
    useFallback = true;
    canvas.style.display = 'none';
    mjpeg.style.display = 'block';
    mjpeg.src = '/stream.mjpg?' + Date.now();
    mjpeg.onload = () => {
      overlay.classList.add('hidden');
      statsEl.textContent = 'MJPEG Stream';
    };
    mjpeg.onerror = () => {
      overlay.classList.remove('hidden');
      overlayTitle.textContent = 'Connecting…';
      setTimeout(() => { mjpeg.src = '/stream.mjpg?' + Date.now(); }, 2000);
    };
  }

  connect();
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Cast Manager Factory
// ---------------------------------------------------------------------------

function createCastManager({ getActiveTabWebContents, getMainWindow, notify, userDataPath }) {
  let isStreaming = false;
  let isPaused = false;
  let currentSource = 'screen'; // 'screen' | 'tab' | 'window'
  let targetFps = 30;
  let jpegQuality = 75;
  let activeTabId = null;
  let streamTitle = 'Entire Screen';

  let httpServer = null;
  let assignedPort = 8554;
  let activeWsClients = new Set();
  let activeMjpegResponses = new Set();
  let activeClientDetails = new Map(); // socket/res -> { ip, device, protocol, connectedAt }
  let captureInterval = null;
  let isCapturingFrame = false;
  let latestFrameBuffer = null;

  let streamStartTime = 0;
  let totalFramesSent = 0;
  let liveFps = 0;
  let framesInCurrentSecond = 0;
  let lastSecondMark = Date.now();

  let discoveredDevices = [];
  let isSubnetScanning = false;
  let ssdpSocket = null;
  let mdnsSocket = null;

  const devicesStoreFile = userDataPath ? path.join(userDataPath, 'cast-devices.json') : null;

  function loadSavedDevices() {
    try {
      if (devicesStoreFile && fs.existsSync(devicesStoreFile)) {
        const raw = JSON.parse(fs.readFileSync(devicesStoreFile, 'utf8'));
        if (Array.isArray(raw)) discoveredDevices = raw;
      }
    } catch {}
  }

  function saveDevices() {
    try {
      if (devicesStoreFile) {
        fs.writeFileSync(devicesStoreFile, JSON.stringify(discoveredDevices, null, 2), 'utf8');
      }
    } catch {}
  }

  loadSavedDevices();

  function parseDeviceType(ua = '') {
    if (/iphone/i.test(ua)) return 'iPhone';
    if (/ipad/i.test(ua)) return 'iPad';
    if (/android/i.test(ua)) return /mobile/i.test(ua) ? 'Android Phone' : 'Android Tablet / TV';
    if (/smart-tv|googletv|tizen|webos|appletv|roku|crkey/i.test(ua)) return 'Smart TV';
    if (/macintosh/i.test(ua)) return 'Mac';
    if (/windows/i.test(ua)) return 'Windows PC';
    if (/linux/i.test(ua)) return 'Linux PC';
    return 'Web Receiver';
  }

  // -------------------------------------------------------------------------
  // Frame Capture Loop
  // -------------------------------------------------------------------------

  async function captureSingleFrame() {
    if (isCapturingFrame || isPaused) return;
    isCapturingFrame = true;

    try {
      let nativeImg = null;

      if (currentSource === 'tab') {
        const wc = getActiveTabWebContents ? getActiveTabWebContents() : null;
        if (wc && !wc.isDestroyed()) {
          try { nativeImg = await wc.capturePage(); } catch {}
        }
      } else if (currentSource === 'screen') {
        try {
          const primary = screen.getPrimaryDisplay();
          const sources = await desktopCapturer.getSources({
            types: ['screen'],
            thumbnailSize: {
              width: primary.bounds.width || 1920,
              height: primary.bounds.height || 1080,
            },
          });
          if (sources.length > 0 && sources[0].thumbnail && !sources[0].thumbnail.isEmpty()) {
            nativeImg = sources[0].thumbnail;
          }
        } catch {}
      } else if (currentSource === 'window') {
        const win = getMainWindow ? getMainWindow() : null;
        if (win && !win.isDestroyed()) {
          try { nativeImg = await win.webContents.capturePage(); } catch {}
        } else {
          const wins = webContents.getAllWebContents();
          const mainWc = wins.find((w) => !w.isDestroyed() && w.getType() === 'window');
          if (mainWc) {
            try { nativeImg = await mainWc.capturePage(); } catch {}
          }
        }
      }

      // Robust fallback chain: Prioritize capturing the active web page tab first
      // so the browser web contents are ALWAYS visible on the cast target!
      if (!nativeImg || nativeImg.isEmpty()) {
        const wc = getActiveTabWebContents ? getActiveTabWebContents() : null;
        if (wc && !wc.isDestroyed()) {
          try { nativeImg = await wc.capturePage(); } catch {}
        }
      }

      if (!nativeImg || nativeImg.isEmpty()) {
        const wins = webContents.getAllWebContents();
        const anyWc = wins.find((w) => !w.isDestroyed() && w.getType() === 'webview');
        if (anyWc) {
          try { nativeImg = await anyWc.capturePage(); } catch {}
        }
      }

      if (!nativeImg || nativeImg.isEmpty()) {
        const win = getMainWindow ? getMainWindow() : null;
        if (win && !win.isDestroyed()) {
          try { nativeImg = await win.webContents.capturePage(); } catch {}
        }
      }

      if (nativeImg && !nativeImg.isEmpty()) {
        const jpeg = nativeImg.toJPEG(jpegQuality);
        latestFrameBuffer = jpeg;
        broadcastFrame(jpeg);
      }
    } catch (err) {
      // Non-fatal: tabs navigate or re-render
    } finally {
      isCapturingFrame = false;
    }
  }

  function broadcastFrame(jpegBuffer) {
    totalFramesSent++;
    framesInCurrentSecond++;

    const now = Date.now();
    if (now - lastSecondMark >= 1000) {
      liveFps = framesInCurrentSecond;
      framesInCurrentSecond = 0;
      lastSecondMark = now;
      notifyUiStatus();
    }

    // 1. WebSocket binary frame broadcast
    if (activeWsClients.size > 0) {
      const frame = createWsFrame(jpegBuffer, 0x82);
      for (const client of activeWsClients) {
        try {
          if (client.writable && client.writableLength < 512 * 1024) {
            client.write(frame);
          }
        } catch {
          activeWsClients.delete(client);
        }
      }
    }

    // 2. HTTP MJPEG stream broadcast
    if (activeMjpegResponses.size > 0) {
      const header = `--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpegBuffer.length}\r\n\r\n`;
      const footer = '\r\n';
      for (const res of activeMjpegResponses) {
        try {
          if (!res.writableEnded) {
            res.write(header);
            res.write(jpegBuffer);
            res.write(footer);
          }
        } catch {
          activeMjpegResponses.delete(res);
        }
      }
    }
  }

  function startCaptureLoop() {
    stopCaptureLoop();
    // Fire initial frame immediately so buffer is warm
    captureSingleFrame().catch(() => {});
    const intervalMs = Math.max(16, Math.floor(1000 / targetFps));
    captureInterval = setInterval(captureSingleFrame, intervalMs);
  }

  function stopCaptureLoop() {
    if (captureInterval) {
      clearInterval(captureInterval);
      captureInterval = null;
    }
    isCapturingFrame = false;
  }

  // -------------------------------------------------------------------------
  // HTTP & WebSocket Server
  // -------------------------------------------------------------------------

  function startHttpServer(portToTry = 8554) {
    return new Promise((resolve, reject) => {
      const srv = http.createServer((req, res) => {
        const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        const pathname = parsedUrl.pathname;

        res.setHeader('Access-Control-Allow-Origin', '*');

        if (pathname === '/') {
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
          });
          res.end(getReceiverHtml(streamTitle, assignedPort));
        } else if (pathname === '/stream.mjpg') {
          res.writeHead(200, {
            'Content-Type': 'multipart/x-mixed-replace; boundary=--frame',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Connection': 'keep-alive',
            'Pragma': 'no-cache',
            'Access-Control-Allow-Origin': '*',
          });
          const clientIp = (req.socket.remoteAddress || '').replace(/^.*:/, '') || '127.0.0.1';
          const ua = req.headers['user-agent'] || '';
          activeMjpegResponses.add(res);
          activeClientDetails.set(res, {
            ip: clientIp,
            device: parseDeviceType(ua),
            protocol: 'MJPEG',
            connectedAt: Date.now(),
          });
          notifyUiStatus();

          // Immediately push current frame to new receiver so there's zero initial blackout
          if (latestFrameBuffer) {
            try {
              res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${latestFrameBuffer.length}\r\n\r\n`);
              res.write(latestFrameBuffer);
              res.write('\r\n');
            } catch {}
          }

          req.on('close', () => {
            activeMjpegResponses.delete(res);
            activeClientDetails.delete(res);
            notifyUiStatus();
          });
        } else if (pathname === '/preview.jpg') {
          const sendPreview = () => {
            const buf = latestFrameBuffer || FALLBACK_JPEG;
            try {
              res.writeHead(200, {
                'Content-Type': 'image/jpeg',
                'Content-Length': buf.length,
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                'Access-Control-Allow-Origin': '*',
              });
              res.end(buf);
            } catch {}
          };

          if (latestFrameBuffer) {
            sendPreview();
          } else {
            captureSingleFrame().then(sendPreview).catch(sendPreview);
          }
        } else if (pathname === '/qr.svg') {
          const url = `http://${getPrimaryLocalIp()}:${assignedPort}`;
          const svg = generateSvgQr(url);
          res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8' });
          res.end(svg);
        } else if (pathname === '/status') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(getStatus()));
        } else {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not Found');
        }
      });

      // WebSocket Upgrade Handler (RFC 6455)
      srv.on('upgrade', (req, socket) => {
        if (req.url === '/ws') {
          const key = req.headers['sec-websocket-key'];
          if (!key) {
            socket.destroy();
            return;
          }
          const digest = crypto
            .createHash('sha1')
            .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
            .digest('base64');

          socket.write(
            'HTTP/1.1 101 Switching Protocols\r\n' +
            'Upgrade: websocket\r\n' +
            'Connection: Upgrade\r\n' +
            `Sec-WebSocket-Accept: ${digest}\r\n` +
            '\r\n',
          );

          const clientIp = (socket.remoteAddress || (req.socket && req.socket.remoteAddress) || '').replace(/^.*:/, '') || '127.0.0.1';
          const ua = req.headers['user-agent'] || '';
          activeWsClients.add(socket);
          activeClientDetails.set(socket, {
            ip: clientIp,
            device: parseDeviceType(ua),
            protocol: 'WebSocket',
            connectedAt: Date.now(),
          });
          notifyUiStatus();

          // Immediately send metadata & latest frame if available
          try {
            socket.write(
              createWsFrame(JSON.stringify({ type: 'meta', title: streamTitle, fps: targetFps }), 0x81),
            );
            if (latestFrameBuffer) {
              socket.write(createWsFrame(latestFrameBuffer, 0x82));
            }
          } catch {}

          socket.on('data', (chunk) => {
            if (chunk.length < 2) return;
            const opcode = chunk[0] & 0x0f;
            if (opcode === 0x08) {
              // Close frame
              socket.end();
            } else if (opcode === 0x09) {
              // Ping -> Pong
              const pong = Buffer.from(chunk);
              pong[0] = 0x8a;
              socket.write(pong);
            }
          });

          socket.on('close', () => {
            activeWsClients.delete(socket);
            activeClientDetails.delete(socket);
            notifyUiStatus();
          });

          socket.on('error', () => {
            activeWsClients.delete(socket);
            activeClientDetails.delete(socket);
            notifyUiStatus();
          });
        } else {
          socket.destroy();
        }
      });

      srv.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          if (portToTry < 8560) {
            resolve(startHttpServer(portToTry + 1));
          } else if (portToTry !== 0) {
            resolve(startHttpServer(0));
          } else {
            reject(err);
          }
        } else {
          reject(err);
        }
      });

      srv.listen(portToTry, '0.0.0.0', () => {
        assignedPort = srv.address().port;
        httpServer = srv;
        resolve(assignedPort);
      });
    });
  }

  // -------------------------------------------------------------------------
  // Discovered Devices (Subnet HTTP Probing, SSDP, mDNS, DLNA, Cast)
  // -------------------------------------------------------------------------

  function fetchHttpJsonOrText(url, timeoutMs = 900) {
    return new Promise((resolve, reject) => {
      let timer = null;
      let req = null;
      let settled = false;

      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        if (req) {
          try { req.destroy(); } catch {}
        }
        reject(new Error('ETIMEDOUT'));
      }, timeoutMs);

      try {
        const u = new URL(url);
        req = http.get(
          {
            hostname: u.hostname,
            port: u.port,
            path: u.pathname + u.search,
            agent: false,
            headers: {
              'Accept': 'application/json, text/xml, */*',
              'User-Agent': 'BriskBrowser/1.0',
            },
          },
          (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => {
              body += chunk;
              if (body.length > 65536 && req) {
                try { req.destroy(); } catch {}
              }
            });
            res.on('end', () => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              resolve({ statusCode: res.statusCode, headers: res.headers, body });
            });
          },
        );

        req.on('error', (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(err);
        });
      } catch (err) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  async function probeDeviceIp(ip, timeoutMs = 1100, allowGeneric = false) {
    if (!ip || typeof ip !== 'string') return null;
    ip = ip.trim();
    if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) return null;

    // Run primary device checks concurrently in parallel
    const [castProbe, rokuProbe, dlnaProbe] = await Promise.allSettled([
      fetchHttpJsonOrText(`http://${ip}:8008/setup/eureka_info?params=name,device_info,version,build_info`, timeoutMs),
      fetchHttpJsonOrText(`http://${ip}:8060/query/device-info`, timeoutMs),
      fetchHttpJsonOrText(`http://${ip}:8008/ssdp/device-desc.xml`, timeoutMs),
    ]);

    // 1. Google Cast / Android TV check
    if (castProbe.status === 'fulfilled' && castProbe.value.statusCode === 200 && castProbe.value.body) {
      const body = castProbe.value.body;
      let name = '';
      let model = 'Google Cast / Android TV';
      try {
        const data = JSON.parse(body);
        name = data.name || (data.device_info && data.device_info.model_name);
        if (data.device_info && data.device_info.model_name) {
          model = data.device_info.model_name;
        }
      } catch {
        const fn = /"name"\s*:\s*"([^"]+)"/.exec(body);
        if (fn) name = fn[1];
      }
      const dev = {
        id: `cast_${ip}`,
        name: name || `Cast Device (${ip})`,
        model,
        type: 'chromecast',
        ip,
        canDirectPlay: true,
      };
      addDevice(dev);
      return dev;
    }

    // 2. Roku device check
    if (rokuProbe.status === 'fulfilled' && rokuProbe.value.statusCode === 200 && rokuProbe.value.body) {
      const body = rokuProbe.value.body;
      const fnMatch = /<(?:user-device-name|friendly-device-name)>(.*?)<\//i.exec(body);
      const mnMatch = /<model-name>(.*?)<\//i.exec(body);
      const name = fnMatch ? fnMatch[1].trim() : `Roku TV (${ip})`;
      const model = mnMatch ? mnMatch[1].trim() : 'Roku Player';
      const dev = {
        id: `roku_${ip}`,
        name,
        model,
        type: 'roku',
        ip,
        canDirectPlay: false,
      };
      addDevice(dev);
      return dev;
    }

    // 3. DIAL & DLNA check on port 8008
    if (dlnaProbe.status === 'fulfilled' && dlnaProbe.value.statusCode === 200 && dlnaProbe.value.body && /<friendlyName>/i.test(dlnaProbe.value.body)) {
      const xml = dlnaProbe.value.body;
      const fnMatch = /<friendlyName>(.*?)<\/friendlyName>/i.exec(xml);
      const mnMatch = /<modelName>(.*?)<\/modelName>/i.exec(xml);
      const avMatch = /<serviceType>urn:schemas-upnp-org:service:AVTransport:1<\/serviceType>[\s\S]*?<controlURL>(.*?)<\/controlURL>/i.exec(xml);
      let controlUrl = null;
      if (avMatch) {
        const rawCtrl = avMatch[1].trim();
        controlUrl = rawCtrl.startsWith('http') ? rawCtrl : `http://${ip}:8008${rawCtrl.startsWith('/') ? '' : '/'}${rawCtrl}`;
      }
      const dev = {
        id: `dlna_${ip}_8008`,
        name: fnMatch ? fnMatch[1].trim() : `Smart TV (${ip})`,
        model: mnMatch ? mnMatch[1].trim() : 'Smart TV',
        type: controlUrl ? 'dlna' : 'smart-tv',
        ip,
        controlUrl,
        canDirectPlay: Boolean(controlUrl),
      };
      addDevice(dev);
      return dev;
    }

    // 4. Secondary ports for explicit manual additions or deep scans
    if (allowGeneric) {
      for (const port of [7676, 8001]) {
        try {
          const path = port === 7676 ? '/rootDesc.xml' : '/api/v2/';
          const res = await fetchHttpJsonOrText(`http://${ip}:${port}${path}`, timeoutMs);
          if (res.statusCode === 200 && res.body) {
            if (path.includes('api/v2')) {
              let name = '';
              let model = 'Samsung Smart TV';
              try {
                const data = JSON.parse(res.body);
                name = data.device?.name || data.name;
                model = data.device?.modelName || model;
              } catch {}
              const dev = {
                id: `samsung_${ip}`,
                name: name || `Samsung TV (${ip})`,
                model,
                type: 'smart-tv',
                ip,
                canDirectPlay: false,
              };
              addDevice(dev);
              return dev;
            }
          }
        } catch {}
      }

      const dev = {
        id: `manual_${ip}`,
        name: `Device (${ip})`,
        model: 'Manual Device',
        type: 'network',
        ip,
        canDirectPlay: false,
      };
      addDevice(dev);
      return dev;
    }

    return null;
  }

  async function scanSubnet(baseSubnet) {
    const ips = [];
    for (let i = 1; i <= 254; i++) {
      ips.push(`${baseSubnet}.${i}`);
    }
    const batchSize = 40;
    for (let i = 0; i < ips.length; i += batchSize) {
      const batch = ips.slice(i, i + batchSize);
      await Promise.allSettled(batch.map((ip) => probeDeviceIp(ip, 1500)));
    }
  }

  function trySsdpMulticast() {
    try {
      if (ssdpSocket) {
        try { ssdpSocket.close(); } catch {}
      }
      ssdpSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

      ssdpSocket.on('message', (msg, rinfo) => {
        const text = msg.toString('utf8');
        const headers = {};
        for (const line of text.split('\r\n')) {
          const idx = line.indexOf(':');
          if (idx > 0) {
            headers[line.slice(0, idx).trim().toUpperCase()] = line.slice(idx + 1).trim();
          }
        }

        const location = headers['LOCATION'];
        const usn = headers['USN'] || `${rinfo.address}:${rinfo.port}`;
        const st = headers['ST'] || '';

        if (location && (st.includes('MediaRenderer') || st.includes('dial') || /tv|render/i.test(st))) {
          fetchDeviceDescription(location, usn, rinfo.address);
        }
      });
      ssdpSocket.on('error', () => {});

      ssdpSocket.bind(0, () => {
        try {
          const msearch = Buffer.from(
            'M-SEARCH * HTTP/1.1\r\n' +
            'HOST: 239.255.255.250:1900\r\n' +
            'MAN: "ssdp:discover"\r\n' +
            'MX: 2\r\n' +
            'ST: urn:schemas-upnp-org:device:MediaRenderer:1\r\n' +
            '\r\n',
          );
          ssdpSocket.send(msearch, 0, msearch.length, 1900, '239.255.255.250');

          const dialSearch = Buffer.from(
            'M-SEARCH * HTTP/1.1\r\n' +
            'HOST: 239.255.255.250:1900\r\n' +
            'MAN: "ssdp:discover"\r\n' +
            'MX: 2\r\n' +
            'ST: urn:dial-multiscreen-org:service:dial:1\r\n' +
            '\r\n',
          );
          ssdpSocket.send(dialSearch, 0, dialSearch.length, 1900, '239.255.255.250');
        } catch {}
      });

      setTimeout(() => {
        if (ssdpSocket) {
          try { ssdpSocket.close(); } catch {}
          ssdpSocket = null;
        }
      }, 4000);
    } catch (err) {
      console.warn('[cast] SSDP scan notice:', err.message);
    }
  }

  function tryMdnsMulticast() {
    try {
      if (mdnsSocket) {
        try { mdnsSocket.close(); } catch {}
      }
      mdnsSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

      mdnsSocket.on('message', (msg, rinfo) => {
        const raw = msg.toString('binary');
        const fnMatch = /fn=([^\x00-\x1f]+)/i.exec(raw);
        const mdMatch = /md=([^\x00-\x1f]+)/i.exec(raw);
        if (fnMatch) {
          const friendlyName = fnMatch[1].replace(/[\x00-\x1f]/g, '').trim();
          const modelName = mdMatch ? mdMatch[1].replace(/[\x00-\x1f]/g, '').trim() : 'Chromecast';
          addDevice({
            id: 'cast_' + rinfo.address,
            name: friendlyName,
            type: 'chromecast',
            model: modelName,
            ip: rinfo.address,
            canDirectPlay: true,
          });
        }
      });
      mdnsSocket.on('error', () => {});

      mdnsSocket.bind(0, () => {
        try {
          const parts = '_googlecast._tcp.local'.split('.');
          const qnameParts = [];
          for (const p of parts) {
            qnameParts.push(Buffer.from([p.length]));
            qnameParts.push(Buffer.from(p, 'utf8'));
          }
          qnameParts.push(Buffer.from([0]));

          const header = Buffer.alloc(12);
          header.writeUInt16BE(1, 4);
          const footer = Buffer.alloc(4);
          footer.writeUInt16BE(12, 0);
          footer.writeUInt16BE(1, 2);

          const pkt = Buffer.concat([header, ...qnameParts, footer]);
          mdnsSocket.send(pkt, 0, pkt.length, 5353, '224.0.0.251');
        } catch {}
      });

      setTimeout(() => {
        if (mdnsSocket) {
          try { mdnsSocket.close(); } catch {}
          mdnsSocket = null;
        }
      }, 4000);
    } catch (err) {
      console.warn('[cast] mDNS scan notice:', err.message);
    }
  }

  async function discoverDevices() {
    // 1. Parallel multicast SSDP & mDNS
    trySsdpMulticast();
    tryMdnsMulticast();

    // 2. Fast Subnet Unicast Probing
    const ifaces = getLocalIpAddresses();
    const nonVirtual = ifaces.filter((iface) => !iface.isVirtual);
    const subnets = new Set();
    for (const iface of nonVirtual) {
      const parts = iface.ip.split('.');
      if (parts.length === 4) {
        subnets.add(`${parts[0]}.${parts[1]}.${parts[2]}`);
      }
    }

    const scanPromise = (async () => {
      if (isSubnetScanning) return;
      isSubnetScanning = true;
      try {
        for (const baseSubnet of subnets) {
          await scanSubnet(baseSubnet);
        }
      } catch (err) {
        console.warn('[cast] Subnet scan error:', err.message);
      } finally {
        isSubnetScanning = false;
        notifyUiDevices();
      }
    })();

    // Await scan if no devices are loaded yet so initial UI render gets them immediately
    if (discoveredDevices.length === 0) {
      await scanPromise;
    }

    return [...discoveredDevices];
  }

  function fetchDeviceDescription(locationUrl, usn, ip) {
    try {
      const u = new URL(locationUrl);
      const req = http.get(locationUrl, { timeout: 2500 }, (res) => {
        let xml = '';
        res.on('data', (c) => (xml += c));
        res.on('end', () => {
          const fnMatch = /<friendlyName>(.*?)<\/friendlyName>/i.exec(xml);
          const mnMatch = /<modelName>(.*?)<\/modelName>/i.exec(xml);
          const name = fnMatch ? fnMatch[1].trim() : `Smart TV (${ip})`;
          const model = mnMatch ? mnMatch[1].trim() : 'DLNA TV';

          const avMatch = /<serviceType>urn:schemas-upnp-org:service:AVTransport:1<\/serviceType>[\s\S]*?<controlURL>(.*?)<\/controlURL>/i.exec(xml);
          let controlUrl = null;
          if (avMatch) {
            const rawCtrl = avMatch[1].trim();
            controlUrl = rawCtrl.startsWith('http') ? rawCtrl : `${u.origin}${rawCtrl.startsWith('/') ? '' : '/'}${rawCtrl}`;
          }

          addDevice({
            id: usn || `dlna_${ip}`,
            name,
            model,
            type: controlUrl ? 'dlna' : 'smart-tv',
            ip,
            location: locationUrl,
            controlUrl,
            canDirectPlay: Boolean(controlUrl),
          });
        });
      });
      req.on('error', () => {});
    } catch {}
  }

  function addDevice(dev) {
    if (!dev || !dev.ip) return;
    const existing = discoveredDevices.findIndex(
      (d) => d.id === dev.id || (d.ip === dev.ip && d.type === dev.type) || (d.ip === dev.ip && d.name === dev.name)
    );
    if (existing >= 0) {
      discoveredDevices[existing] = { ...discoveredDevices[existing], ...dev, lastSeen: Date.now() };
    } else {
      discoveredDevices.push({ ...dev, lastSeen: Date.now() });
    }
    saveDevices();
    notifyUiDevices();
  }

  // -------------------------------------------------------------------------
  // DLNA AVTransport Action (Play stream directly on Smart TV)
  // -------------------------------------------------------------------------

  async function castToDlnaDevice(deviceId) {
    const dev = discoveredDevices.find((d) => d.id === deviceId);
    if (!dev || !dev.controlUrl) {
      return { success: false, error: 'Device not capable of direct DLNA streaming' };
    }

    const streamUrl = `http://${getPrimaryLocalIp()}:${assignedPort}/stream.mjpg`;

    try {
      // Step 1: SetAVTransportURI
      const setUriSoap = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:SetAVTransportURI xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">
      <InstanceID>0</InstanceID>
      <CurrentURI>${streamUrl}</CurrentURI>
      <CurrentURIMetaData></CurrentURIMetaData>
    </u:SetAVTransportURI>
  </s:Body>
</s:Envelope>`;

      await sendSoapRequest(dev.controlUrl, 'urn:schemas-upnp-org:service:AVTransport:1#SetAVTransportURI', setUriSoap);

      // Step 2: Play
      const playSoap = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:Play xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">
      <InstanceID>0</InstanceID>
      <Speed>1</Speed>
    </u:Play>
  </s:Body>
</s:Envelope>`;

      await sendSoapRequest(dev.controlUrl, 'urn:schemas-upnp-org:service:AVTransport:1#Play', playSoap);
      return { success: true, deviceName: dev.name };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  function sendSoapRequest(controlUrl, action, body) {
    return new Promise((resolve, reject) => {
      try {
        const u = new URL(controlUrl);
        const req = http.request(
          controlUrl,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'text/xml; charset="utf-8"',
              'SOAPAction': `"${action}"`,
              'Content-Length': Buffer.byteLength(body),
            },
            timeout: 5000,
          },
          (res) => {
            let data = '';
            res.on('data', (c) => (data += c));
            res.on('end', () => {
              if (res.statusCode >= 200 && res.statusCode < 300) resolve(data);
              else reject(new Error(`SOAP error HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
            });
          },
        );
        req.on('error', reject);
        req.write(body);
        req.end();
      } catch (err) {
        reject(err);
      }
    });
  }

  // -------------------------------------------------------------------------
  // Google Cast v2 Direct Streaming (Smart TVs & Android TVs on TLS:8009)
  // -------------------------------------------------------------------------

  let activeCastClient = null;

  function disconnectActiveCastClient() {
    if (activeCastClient) {
      try {
        if (activeCastClient.pingInterval) clearInterval(activeCastClient.pingInterval);
        if (activeCastClient.updateInterval) clearInterval(activeCastClient.updateInterval);
        if (activeCastClient.socket && !activeCastClient.socket.destroyed) {
          if (activeCastClient.sessionId) {
            try {
              activeCastClient.socket.write(
                buildCastMessage(
                  'sender-0',
                  'receiver-0',
                  'urn:x-cast:com.google.cast.receiver',
                  JSON.stringify({ type: 'STOP', sessionId: activeCastClient.sessionId, requestId: 999 }),
                ),
              );
            } catch {}
          }
          activeCastClient.socket.end();
        }
      } catch {}
      activeCastClient = null;
    }
  }

  function encodeVarint(val) {
    const buf = [];
    while (val > 0x7f) {
      buf.push((val & 0x7f) | 0x80);
      val >>>= 7;
    }
    buf.push(val & 0x7f);
    return Buffer.from(buf);
  }

  function encodeStringField(fieldNumber, str) {
    const tag = (fieldNumber << 3) | 2;
    const strBuf = Buffer.from(str, 'utf8');
    return Buffer.concat([Buffer.from([tag]), encodeVarint(strBuf.length), strBuf]);
  }

  function buildCastMessage(sourceId, destId, namespace, payloadJson) {
    const f1 = Buffer.from([0x08, 0x00]);
    const f2 = encodeStringField(2, sourceId);
    const f3 = encodeStringField(3, destId);
    const f4 = encodeStringField(4, namespace);
    const f5 = Buffer.from([0x28, 0x00]);
    const f6 = encodeStringField(6, payloadJson);

    const body = Buffer.concat([f1, f2, f3, f4, f5, f6]);
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(body.length, 0);
    return Buffer.concat([lenBuf, body]);
  }

  function decodeCastMessages(buffer) {
    const msgs = [];
    let offset = 0;
    while (offset + 4 <= buffer.length) {
      const len = buffer.readUInt32BE(offset);
      if (offset + 4 + len > buffer.length) break;
      const body = buffer.slice(offset + 4, offset + 4 + len);
      offset += 4 + len;

      let pos = 0;
      let sourceId = '', destId = '', ns = '', payload = '';
      while (pos < body.length) {
        const tag = body[pos++];
        const wireType = tag & 0x07;
        const fieldNum = tag >>> 3;
        if (wireType === 0) {
          while (pos < body.length) {
            const b = body[pos++];
            if (!(b & 0x80)) break;
          }
        } else if (wireType === 2) {
          let strLen = 0, shift = 0;
          while (pos < body.length) {
            const b = body[pos++];
            strLen |= (b & 0x7f) << shift;
            if (!(b & 0x80)) break;
            shift += 7;
          }
          const s = body.slice(pos, pos + strLen);
          pos += strLen;
          if (fieldNum === 2) sourceId = s.toString('utf8');
          if (fieldNum === 3) destId = s.toString('utf8');
          if (fieldNum === 4) ns = s.toString('utf8');
          if (fieldNum === 6) payload = s.toString('utf8');
        } else {
          break;
        }
      }
      msgs.push({ sourceId, destId, ns, payload });
    }
    return { msgs, remaining: buffer.slice(offset) };
  }

  async function castToGoogleCastDevice(dev) {
    disconnectActiveCastClient();

    const host = dev.ip;
    const port = 8009;
    const primaryIp = getPrimaryLocalIp();
    const receiverPageUrl = `http://${primaryIp}:${assignedPort}`;
    const previewUrl = `http://${primaryIp}:${assignedPort}/preview.jpg`;

    // Ensure first frame is ready before initiating stream so TV sees screen immediately
    if (!latestFrameBuffer) {
      await captureSingleFrame().catch(() => {});
    }

    return new Promise((resolve) => {
      let resolved = false;
      let rxBuf = Buffer.alloc(0);
      let transportId = null;
      let sessionId = null;
      let reqId = 1;
      let launchedApp = false;
      let sentUrl = false;
      let sentOnReady = false;
      let triedFallback = false;
      let readyTimeout = null;

      const finish = (result) => {
        if (resolved) return;
        resolved = true;
        if (readyTimeout) clearTimeout(readyTimeout);
        resolve(result);
      };

      const timer = setTimeout(() => {
        finish({ success: false, error: 'Cast device connection timed out' });
      }, 15000);

      try {
        const socket = tls.connect(port, host, { rejectUnauthorized: false }, () => {
          socket.write(buildCastMessage('sender-0', 'receiver-0', 'urn:x-cast:com.google.cast.tp.connection', JSON.stringify({ type: 'CONNECT' })));
          socket.write(buildCastMessage('sender-0', 'receiver-0', 'urn:x-cast:com.google.cast.tp.heartbeat', JSON.stringify({ type: 'PING' })));
          // Query receiver status first to cleanly stop any running stale session before launch
          socket.write(buildCastMessage('sender-0', 'receiver-0', 'urn:x-cast:com.google.cast.receiver', JSON.stringify({ type: 'GET_STATUS', requestId: reqId++ })));
        });

        const pingInterval = setInterval(() => {
          if (socket && !socket.destroyed) {
            socket.write(buildCastMessage('sender-0', 'receiver-0', 'urn:x-cast:com.google.cast.tp.heartbeat', JSON.stringify({ type: 'PING' })));
            if (transportId && !sentUrl) {
              socket.write(buildCastMessage('sender-0', transportId, 'urn:x-cast:com.google.cast.tp.heartbeat', JSON.stringify({ type: 'PING' })));
            }
          }
        }, 2000);

        function launchDashCast() {
          if (socket && !socket.destroyed) {
            socket.write(buildCastMessage('sender-0', 'receiver-0', 'urn:x-cast:com.google.cast.receiver', JSON.stringify({
              type: 'LAUNCH',
              appId: '84912283',
              requestId: reqId++,
            })));
          }
        }

        function launchDefaultMediaReceiver() {
          triedFallback = true;
          if (socket && !socket.destroyed) {
            socket.write(buildCastMessage('sender-0', 'receiver-0', 'urn:x-cast:com.google.cast.receiver', JSON.stringify({
              type: 'LAUNCH',
              appId: 'CC1AD845',
              requestId: reqId++,
            })));
          }
        }

        function sendDashCastUrl(isReadySignal = false) {
          if (!socket || socket.destroyed || !transportId) return;
          if (isReadySignal) {
            if (sentOnReady) return;
            sentOnReady = true;
          } else if (sentUrl) {
            return;
          }
          sentUrl = true;
          const dashPayload = JSON.stringify({
            url: receiverPageUrl,
            force: true,
            reload: false,
            reload_time: 0,
          });
          socket.write(buildCastMessage('sender-0', transportId, 'urn:x-cast:com.madmod.dashcast', dashPayload));

          activeCastClient = {
            socket,
            pingInterval,
            transportId,
            sessionId,
            ip: host,
            deviceId: dev.id,
            deviceName: dev.name,
            connectedAt: Date.now(),
          };

          notifyUiStatus();
          clearTimeout(timer);
          finish({ success: true, deviceName: dev.name, deviceId: dev.id });
        }

        socket.on('data', (chunk) => {
          rxBuf = Buffer.concat([rxBuf, chunk]);
          const { msgs, remaining } = decodeCastMessages(rxBuf);
          rxBuf = remaining;

          for (const m of msgs) {
            try {
              const parsed = JSON.parse(m.payload);

              if (parsed.type === 'RECEIVER_STATUS') {
                const apps = parsed.status?.applications || [];

                // Step 1: Clean start - if another app or stale session is running, cleanly STOP it first
                if (!launchedApp) {
                  launchedApp = true;
                  if (apps.length > 0) {
                    socket.write(buildCastMessage('sender-0', 'receiver-0', 'urn:x-cast:com.google.cast.receiver', JSON.stringify({
                      type: 'STOP',
                      sessionId: apps[0].sessionId,
                      requestId: reqId++,
                    })));
                    setTimeout(launchDashCast, 600);
                  } else {
                    launchDashCast();
                  }
                  return;
                }

                // Step 2: Handle DashCast receiver app
                const dashApp = apps.find((a) => a.appId === '84912283');
                if (dashApp) {
                  transportId = dashApp.transportId;
                  sessionId = dashApp.sessionId;

                  socket.write(buildCastMessage('sender-0', transportId, 'urn:x-cast:com.google.cast.tp.connection', JSON.stringify({ type: 'CONNECT' })));

                  // Send URL when DashCast is ready, or after 6s fallback
                  if (dashApp.statusText === 'Application ready') {
                    if (readyTimeout) {
                      clearTimeout(readyTimeout);
                      readyTimeout = null;
                    }
                    sendDashCastUrl(true);
                  } else if (!readyTimeout && !sentUrl) {
                    readyTimeout = setTimeout(() => sendDashCastUrl(false), 6000);
                  }
                  return;
                }

                // Step 3: Handle Default Media Receiver fallback if DashCast not present
                const mediaApp = apps.find((a) => a.appId === 'CC1AD845');
                if (mediaApp && !sentUrl) {
                  transportId = mediaApp.transportId;
                  sessionId = mediaApp.sessionId;
                  socket.write(buildCastMessage('sender-0', transportId, 'urn:x-cast:com.google.cast.tp.connection', JSON.stringify({ type: 'CONNECT' })));

                  setTimeout(() => {
                    if (!sentUrl && socket && !socket.destroyed && transportId) {
                      sentUrl = true;
                      const loadPayload = {
                        type: 'LOAD',
                        requestId: reqId++,
                        autoplay: true,
                        media: {
                          contentId: `${previewUrl}?t=${Date.now()}`,
                          contentType: 'image/jpeg',
                          streamType: 'BUFFERED',
                          metadata: {
                            type: 0,
                            metadataType: 0,
                            title: 'Brisk Cast — Live Screen',
                          },
                        },
                      };
                      socket.write(buildCastMessage('sender-0', transportId, 'urn:x-cast:com.google.cast.media', JSON.stringify(loadPayload)));

                      activeCastClient = {
                        socket,
                        pingInterval,
                        transportId,
                        sessionId,
                        ip: host,
                        deviceId: dev.id,
                        deviceName: dev.name,
                        connectedAt: Date.now(),
                      };

                      notifyUiStatus();
                      clearTimeout(timer);
                      finish({ success: true, deviceName: dev.name, deviceId: dev.id });
                    }
                  }, 400);
                }
              }

              // Fallback to CC1AD845 if DashCast launch error received
              if (parsed.type === 'LAUNCH_ERROR' && !triedFallback) {
                launchDefaultMediaReceiver();
              }
            } catch {}
          }
        });

        socket.on('error', (err) => {
          clearTimeout(timer);
          finish({ success: false, error: err.message });
        });

        socket.on('close', () => {
          clearInterval(pingInterval);
          if (readyTimeout) clearTimeout(readyTimeout);
          if (activeCastClient && activeCastClient.socket === socket) {
            activeCastClient = null;
            notifyUiStatus();
          }
        });
      } catch (err) {
        clearTimeout(timer);
        finish({ success: false, error: err.message });
      }
    });
  }

  async function castToDevice(deviceId) {
    let dev = discoveredDevices.find((d) => d.id === deviceId);
    if (!dev && typeof deviceId === 'string' && deviceId.startsWith('cast_')) {
      const ip = deviceId.replace('cast_', '');
      dev = {
        id: deviceId,
        name: 'Smart TV Pro',
        ip,
        type: 'chromecast',
        canDirectPlay: true,
      };
      addDevice(dev);
    }
    if (!dev) {
      return { success: false, error: 'Device not found' };
    }

    if (!isStreaming) {
      await start({ source: currentSource || 'tab', quality: jpegQuality, fps: targetFps });
    }

    if (dev.type === 'chromecast' || dev.type === 'dial' || dev.ip) {
      return await castToGoogleCastDevice(dev);
    }

    if (dev.controlUrl) {
      return await castToDlnaDevice(deviceId);
    }

    return { success: false, error: 'Unsupported cast protocol for device' };
  }

  // -------------------------------------------------------------------------
  // Public Control APIs
  // -------------------------------------------------------------------------

  async function start({ source = 'screen', quality = 75, fps = 30 } = {}) {
    currentSource = source;
    jpegQuality = Math.max(30, Math.min(95, quality));
    targetFps = Math.max(10, Math.min(60, fps));
    isPaused = false;

    if (!httpServer) {
      await startHttpServer(assignedPort);
    }

    isStreaming = true;
    streamStartTime = Date.now();
    startCaptureLoop();
    // Await first frame capture so initial requests immediately have a valid image buffer
    if (!latestFrameBuffer) {
      await captureSingleFrame().catch(() => {});
    }
    notifyUiStatus();

    // Trigger device discovery scan in the background
    discoverDevices();

    return getStatus();
  }

  function stop() {
    isStreaming = false;
    isPaused = false;
    stopCaptureLoop();
    disconnectActiveCastClient();

    // Close all connected streaming clients
    for (const socket of activeWsClients) {
      try { socket.end(); } catch {}
    }
    activeWsClients.clear();

    for (const res of activeMjpegResponses) {
      try { res.end(); } catch {}
    }
    activeMjpegResponses.clear();

    if (httpServer) {
      try { httpServer.close(); } catch {}
      httpServer = null;
    }

    notifyUiStatus();
    return getStatus();
  }

  function togglePause() {
    if (!isStreaming) return false;
    isPaused = !isPaused;
    notifyUiStatus();
    return isPaused;
  }

  function setActiveTab({ tabId, title }) {
    activeTabId = tabId;
    if (title) streamTitle = title;
    notifyUiStatus();
  }

  async function getSources() {
    const displays = screen.getAllDisplays();
    const primary = screen.getPrimaryDisplay();
    return {
      tab: { id: 'tab', name: 'Active Tab', title: streamTitle },
      screen: {
        id: 'screen',
        name: 'Entire Screen',
        resolution: `${primary.bounds.width}×${primary.bounds.height}`,
        displayCount: displays.length,
      },
      window: { id: 'window', name: 'Browser Window' },
    };
  }

  function getStatus() {
    const primaryIp = getPrimaryLocalIp();
    const url = `http://${primaryIp}:${assignedPort}`;
    const castClientCount = activeCastClient ? 1 : 0;
    const clientCount = activeWsClients.size + activeMjpegResponses.size + castClientCount;
    const uptimeSec = isStreaming ? Math.floor((Date.now() - streamStartTime) / 1000) : 0;

    const clientsList = [...activeClientDetails.values()];
    if (activeCastClient) {
      clientsList.push({
        ip: activeCastClient.ip,
        device: activeCastClient.deviceName || 'Smart TV',
        protocol: 'Google Cast',
        connectedAt: activeCastClient.connectedAt || Date.now(),
      });
    }

    return {
      isStreaming,
      isPaused,
      source: currentSource,
      fps: liveFps || targetFps,
      targetFps,
      quality: jpegQuality,
      port: assignedPort,
      url,
      clientCount,
      title: streamTitle,
      uptimeSec,
      totalFramesSent,
      hasPreview: Boolean(latestFrameBuffer),
      qrSvg: generateSvgQr(url),
      clients: clientsList,
      devices: [...discoveredDevices],
      activeCastDeviceId: activeCastClient ? activeCastClient.deviceId : null,
    };
  }

  function notifyUiStatus() {
    if (typeof notify === 'function') {
      notify('cast-status-changed', getStatus());
    }
  }

  function notifyUiDevices() {
    if (typeof notify === 'function') {
      notify('cast-devices-changed', [...discoveredDevices]);
    }
  }

  return {
    start,
    stop,
    togglePause,
    getStatus,
    getSources,
    setActiveTab,
    discoverDevices,
    probeDeviceIp,
    castToDevice,
    castToDlnaDevice,
    getPrimaryLocalIp,
  };
}

module.exports = {
  createCastManager,
  generateSvgQr,
  getPrimaryLocalIp,
};

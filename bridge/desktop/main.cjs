// Comandero Bridge — proceso principal Electron.
// Una sola ventana con UI de emparejamiento y estado. Toda la lógica de
// impresión vive en src/runner.js (Node puro, sin dependencias nativas).
const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const { startRunner, stopRunner, printTest } = require('./src/runner.cjs');

const CONFIG_DIR = path.join(os.homedir(), '.comandero-bridge');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch { return {}; }
}
function saveConfig(c) {
  try { fs.mkdirSync(CONFIG_DIR, { recursive: true }); fs.writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2)); }
  catch (e) { console.error('saveConfig', e); }
}

function restRequest(supabaseUrl, supabaseKey, method, restPath, body, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const url = new URL(`/rest/v1/${restPath}`, supabaseUrl);
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = https.request(url, {
      method,
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        Accept: 'application/json',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
        ...(method === 'PATCH' ? { Prefer: 'return=minimal' } : {}),
      },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        let parsed = null;
        if (text) { try { parsed = JSON.parse(text); } catch { parsed = text; } }
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(parsed);
        const msg = parsed?.message || parsed?.error || text || `HTTP ${res.statusCode}`;
        reject(new Error(msg));
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('Tiempo agotado conectando con la nube. Revisa la conexión a Internet.')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function printHtmlSilent(html, opts = {}) {
  const { deviceName, paperWidthMm = 80 } = opts;
  return new Promise((resolve, reject) => {
    let done = false;
    const w = new BrowserWindow({
      show: false,
      width: 400, height: 800,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: true },
    });
    const finish = (err) => {
      if (done) return; done = true;
      try { w.destroy(); } catch {}
      err ? reject(err instanceof Error ? err : new Error(String(err))) : resolve();
    };
    const timer = setTimeout(() => finish(new Error('Timeout imprimiendo HTML')), 25000);
    w.webContents.once('did-fail-load', (_e, _c, desc) => { clearTimeout(timer); finish(new Error(desc || 'did-fail-load')); });
    w.webContents.once('did-finish-load', () => {
      // pequeño margen para que cargue el logo y las webfonts
      setTimeout(() => {
        try {
          w.webContents.print({
            silent: true,
            printBackground: true,
            deviceName: deviceName || undefined,
            margins: { marginType: 'none' },
            pageSize: { width: Math.round(paperWidthMm * 1000), height: 297000 },
          }, (success, failure) => {
            clearTimeout(timer);
            if (success) finish();
            else finish(new Error(failure || 'print() devolvió false'));
          });
        } catch (e) { clearTimeout(timer); finish(e); }
      }, 800);
    });
    const dataUrl = 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
    w.loadURL(dataUrl).catch((e) => { clearTimeout(timer); finish(e); });
  });
}

// Renderiza el HTML del ticket a un mapa de bits monocromo y devuelve los
// bytes ESC/POS (GS v 0) listos para enviar a una impresora TCP de red.
// Así conservamos logo, acentos, € y formato exacto en cualquier impresora.
function renderHtmlToEscPosRaster(html, opts = {}) {
  const { widthDots = 576 } = opts;
  const cssWidth = Math.max(200, Math.round(widthDots / 1.5));
  return new Promise((resolve, reject) => {
    let done = false;
    const w = new BrowserWindow({
      show: false,
      width: cssWidth, height: 1200,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: true },
    });
    const finish = (err, value) => {
      if (done) return; done = true;
      try { w.destroy(); } catch {}
      err ? reject(err instanceof Error ? err : new Error(String(err))) : resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('Timeout renderizando HTML a bitmap')), 30000);
    w.webContents.once('did-fail-load', (_e, _c, desc) => finish(new Error(desc || 'did-fail-load')));
    w.webContents.once('did-finish-load', async () => {
      try {
        await new Promise(r => setTimeout(r, 1100)); // logo + webfonts
        let contentHeight = 1200;
        try {
          contentHeight = await w.webContents.executeJavaScript(
            'Math.max(document.body.scrollHeight, document.documentElement.scrollHeight)'
          );
        } catch {}
        const h = Math.min(8000, Math.max(120, Math.ceil(contentHeight) + 20));
        w.setContentSize(cssWidth, h);
        await new Promise(r => setTimeout(r, 250));
        const img = await w.webContents.capturePage();
        const { width: srcW, height: srcH } = img.getSize();
        const bgra = img.toBitmap();
        const dstW = widthDots;
        const dstH = Math.max(1, Math.round(srcH * (dstW / srcW)));
        const rowBytes = Math.ceil(dstW / 8);
        const mono = Buffer.alloc(rowBytes * dstH, 0);
        for (let y = 0; y < dstH; y++) {
          const sy = Math.min(srcH - 1, Math.floor(y * srcH / dstH));
          for (let x = 0; x < dstW; x++) {
            const sx = Math.min(srcW - 1, Math.floor(x * srcW / dstW));
            const idx = (sy * srcW + sx) * 4;
            const b = bgra[idx], g = bgra[idx + 1], r = bgra[idx + 2];
            const lum = (r * 299 + g * 587 + b * 114) / 1000;
            if (lum < 160) mono[y * rowBytes + (x >> 3)] |= (0x80 >> (x & 7));
          }
        }
        const xL = rowBytes & 0xFF, xH = (rowBytes >> 8) & 0xFF;
        const yL = dstH & 0xFF, yH = (dstH >> 8) & 0xFF;
        const out = Buffer.concat([
          Buffer.from([0x1B, 0x40]),                              // ESC @
          Buffer.from([0x1B, 0x61, 0x00]),                        // alineación izquierda
          Buffer.from([0x1D, 0x76, 0x30, 0x00, xL, xH, yL, yH]),  // GS v 0 raster
          mono,
          Buffer.from([0x0A, 0x0A, 0x0A, 0x0A]),                  // line feeds finales
        ]);
        clearTimeout(timer);
        finish(null, out);
      } catch (e) { clearTimeout(timer); finish(e); }
    });
    const dataUrl = 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
    w.loadURL(dataUrl).catch((e) => { clearTimeout(timer); finish(e); });
  });
}

function startRunnerInBackground(cfg) {
  startRunner({ ...cfg, printHtmlSilent, renderHtmlToEscPosRaster }, (status) => {
    runnerStatus = { ...runnerStatus, ...status };
    win?.webContents.send('status', runnerStatus);
  }).catch((e) => {
    runnerStatus = { ...runnerStatus, online: false, error: String(e?.message || e) };
    win?.webContents.send('status', runnerStatus);
  });
}

let win = null;
let tray = null;
let runnerStatus = { online: false, lastJob: null, error: null };

function createWindow() {
  win = new BrowserWindow({
    width: 520, height: 640, resizable: false,
    title: 'Comandero Bridge',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('close', (e) => { if (!app.isQuitting) { e.preventDefault(); win.hide(); } });
  win.webContents.on('render-process-gone', (_e, d) => console.error('renderer gone', d));
}

function createTray() {
  const icon = nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setToolTip('Comandero Bridge');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Abrir', click: () => { win?.show(); } },
    { label: 'Salir', click: () => { app.isQuitting = true; app.quit(); } },
  ]));
  tray.on('click', () => win?.show());
}

app.whenReady().then(async () => {
  createWindow();
  try { createTray(); } catch {}
  const cfg = loadConfig();
  if (cfg.agentId && cfg.pairingCode && cfg.supabaseUrl) {
    await startRunner({ ...cfg, printHtmlSilent, renderHtmlToEscPosRaster }, (status) => {
      runnerStatus = { ...runnerStatus, ...status };
      win?.webContents.send('status', runnerStatus);
    });
  }
});

app.on('before-quit', () => { app.isQuitting = true; });
app.on('window-all-closed', () => { app.isQuitting = true; app.quit(); });

ipcMain.handle('get-config', () => loadConfig());
ipcMain.handle('get-status', () => runnerStatus);

ipcMain.handle('pair', async (_e, { code, supabaseUrl, supabaseKey }) => {
  try {
    const pairingCode = String(code || '').replace(/\D/g, '');
    if (pairingCode.length !== 6) return { ok: false, error: 'Introduce el código de 6 dígitos.' };
    const rows = await restRequest(supabaseUrl, supabaseKey, 'GET', `print_agents?select=*&pairing_code=eq.${encodeURIComponent(pairingCode)}&limit=1`);
    const data = Array.isArray(rows) ? rows[0] : null;
    if (!data) return { ok: false, error: 'Código no encontrado o caducado' };
    if (data.pairing_expires_at && new Date(data.pairing_expires_at) < new Date()) {
      return { ok: false, error: 'El código ha caducado. Pide uno nuevo en la app.' };
    }
    const platform = process.platform;
    const version = app.getVersion();
    await restRequest(supabaseUrl, supabaseKey, 'PATCH', `print_agents?id=eq.${encodeURIComponent(data.id)}&pairing_code=eq.${encodeURIComponent(pairingCode)}`, {
      paired_at: new Date().toISOString(),
      last_heartbeat: new Date().toISOString(),
      platform, version,
    });
    const cfg = { agentId: data.id, restaurantId: data.restaurant_id, pairingCode, supabaseUrl, supabaseKey };
    saveConfig(cfg);
    await stopRunner();
    runnerStatus = { online: false, lastJob: null, error: null };
    startRunnerInBackground(cfg);
    return { ok: true, deviceName: data.device_name };
  } catch (e) {
    console.error('pair error', e);
    return { ok: false, error: (e && e.message) ? e.message : String(e) };
  }
});

ipcMain.handle('unpair', async () => {
  await stopRunner();
  try { fs.unlinkSync(CONFIG_PATH); } catch {}
  runnerStatus = { online: false, lastJob: null, error: null };
  return { ok: true };
});

ipcMain.handle('print-test', async (_e, { printerName, backend, host, port }) => {
  return printTest({ printerName, backend, host, port });
});

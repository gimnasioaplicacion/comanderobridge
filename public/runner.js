// Comandero Bridge (móvil) — runner de impresión.
// Escucha la cola print_jobs en la nube y envía ESC/POS por TCP 9100
// usando el plugin nativo capacitor-tcp-socket (iOS + Android).

const TcpSocket = window.Capacitor?.Plugins?.TcpSocket;

let cfg = null;
let onStatus = () => {};
let heartbeatTimer = null;
let pollTimer = null;
let printerRefreshTimer = null;
let draining = false;
let rerun = false;
const seen = new Set();

// Realtime (WebSocket) + sondeo de respaldo.
const FAST_POLL_MS = 900;
const SLOW_POLL_MS = 3000;
let ws = null;
let wsRef = 0;
let wsHeartbeat = null;
let wsReconnect = null;
let realtimeOk = false;
let realtimeTrusted = true;
const announced = new Set();

function log(stage, extra) {
  try { console.log(`[bridge ${new Date().toISOString()}] ${stage}`, extra ?? ''); } catch {}
}

function setStatus(s) { try { onStatus(s); } catch {} }

async function restRequest(method, restPath, body, timeoutMs = 12000) {
  if (!cfg?.supabaseUrl || !cfg?.supabaseKey) throw new Error('Configuración de nube incompleta. Vuelve a vincular el agente.');
  return restRequestWith(cfg.supabaseUrl, cfg.supabaseKey, method, restPath, body, timeoutMs);
}

export async function restRequestWith(supabaseUrl, supabaseKey, method, restPath, body, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(new URL(`/rest/v1/${restPath}`, supabaseUrl).toString(), {
      method,
      signal: ctrl.signal,
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(method === 'PATCH' ? { Prefer: 'return=representation' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let parsed = null;
    if (text) { try { parsed = JSON.parse(text); } catch { parsed = text; } }
    if (!res.ok) throw new Error(parsed?.message || parsed?.error || text || `HTTP ${res.status}`);
    return parsed;
  } finally { clearTimeout(t); }
}

function rpc(fn, args) { return restRequest('POST', `rpc/${fn}`, args || {}); }

async function heartbeat() {
  if (!cfg) return;
  try {
    await rpc('agent_heartbeat', {
      p_agent_id: cfg.agentId,
      p_pairing_code: String(cfg.pairingCode),
      p_platform: cfg.platform || 'mobile',
      p_version: cfg.version || null,
    });
    setStatus({ online: true, error: null });
  } catch (e) { setStatus({ online: false, error: String(e?.message || e) }); }
}

// -------- caché de impresoras --------
// Evita una llamada a la nube por ticket. Se refresca al arrancar, cada 5 min
// y siempre que falle un envío (por si cambió la IP).
const printerCache = new Map();

async function getPrinter(printerId, force) {
  if (!force && printerCache.has(printerId)) return printerCache.get(printerId);
  const rows = await rpc('agent_get_printer', {
    p_agent_id: cfg.agentId, p_pairing_code: String(cfg.pairingCode), p_printer_id: printerId,
  });
  const printer = Array.isArray(rows) ? rows[0] : null;
  if (printer) printerCache.set(printerId, printer);
  return printer;
}

async function refreshPrinters() {
  for (const id of [...printerCache.keys()]) {
    try { await getPrinter(id, true); } catch {}
  }
}

// Marcar como impreso fuera del camino crítico (no bloquea el siguiente ticket).
function finishAsync(jobId, ok, error) {
  rpc('agent_finish_job', {
    p_agent_id: cfg.agentId, p_pairing_code: String(cfg.pairingCode), p_job_id: jobId,
    p_ok: !!ok, ...(ok ? {} : { p_error: error || 'Error desconocido' }),
  })
    .then(() => log('marcado como impreso', jobId))
    .catch((e) => log('error al marcar el trabajo', String(e?.message || e)));
}

// Un único intento por trabajo: si falla, se marca como error y no se reintenta.
async function processJob(job) {
  if (!job || seen.has(job.id)) return;
  seen.add(job.id);
  log('trabajo recibido en el bridge', job.id);
  if (realtimeOk && !announced.has(job.id) && realtimeTrusted) {
    // Realtime no lo anunció: dejamos de fiarnos y volvemos al sondeo rápido.
    realtimeTrusted = false;
    armTimers();
    log('realtime no anunció el trabajo: sondeo rápido reactivado', job.id);
  }
  const claimedRows = await rpc('agent_claim_job', {
    p_agent_id: cfg.agentId, p_pairing_code: String(cfg.pairingCode), p_job_id: job.id,
  });
  const claimed = Array.isArray(claimedRows) ? claimedRows[0] : null;
  if (!claimed) return;

  let printer = null;
  try { printer = await getPrinter(job.printer_id, false); } catch {}
  if (!printer) {
    finishAsync(job.id, false, 'Impresora no encontrada para este agente');
    return;
  }
  try {
    await sendToPrinter(printer, job.payload ?? claimed.payload ?? null, job);
    log('envío a la impresora completado', job.id);
    finishAsync(job.id, true);
    setStatus({ lastJob: { id: job.id, ok: true, at: Date.now() } });
  } catch (e) {
    const msg = String(e?.message || e);
    printerCache.delete(job.printer_id);
    log('error de impresión', msg);
    finishAsync(job.id, false, msg);
    setStatus({ lastJob: { id: job.id, ok: false, at: Date.now(), error: msg } });
  }
}

// Procesa consecutivamente todos los trabajos nuevos, uno detrás de otro.
async function drainPending() {
  if (!cfg) return;
  if (draining) { rerun = true; return; }
  draining = true;
  try {
    const data = await rpc('agent_pending_jobs', {
      p_agent_id: cfg.agentId, p_pairing_code: String(cfg.pairingCode), p_limit: 50,
    });
    for (const j of (data ?? [])) await processJob(j);
  } catch (e) {
    setStatus({ online: false, error: String(e?.message || e) });
  } finally {
    draining = false;
  }
  if (rerun) { rerun = false; await drainPending(); }
}

// -------- Realtime: los trabajos llegan al instante por WebSocket --------
function realtimeUrl() {
  const base = String(cfg.supabaseUrl).replace(/^http/, 'ws').replace(/\/$/, '');
  return `${base}/realtime/v1/websocket?apikey=${encodeURIComponent(cfg.supabaseKey)}&vsn=1.0.0`;
}

function scheduleRealtimeReconnect() {
  if (!cfg || wsReconnect) return;
  wsReconnect = setTimeout(() => { wsReconnect = null; connectRealtime(); }, 3000);
}

function connectRealtime() {
  if (!cfg || ws || typeof WebSocket === 'undefined') return;
  let sock;
  try { sock = new WebSocket(realtimeUrl()); } catch { scheduleRealtimeReconnect(); return; }
  ws = sock;
  sock.onopen = () => {
    try {
      sock.send(JSON.stringify(['1', String(++wsRef), 'realtime:bridge-print-jobs', 'phx_join', {
        config: {
          postgres_changes: [{ event: 'INSERT', schema: 'public', table: 'print_jobs' }],
          broadcast: { ack: false },
          presence: { key: '' },
        },
      }]));
    } catch {}
    clearInterval(wsHeartbeat);
    wsHeartbeat = setInterval(() => {
      try { sock.send(JSON.stringify([null, String(++wsRef), 'phoenix', 'heartbeat', {}])); } catch {}
    }, 25000);
  };
  sock.onmessage = (ev) => {
    let msg = null;
    try { msg = JSON.parse(ev.data); } catch { return; }
    const topic = msg?.[2], event = msg?.[3], payload = msg?.[4];
    if (event === 'phx_reply' && String(topic || '').startsWith('realtime:')) {
      if (payload?.status === 'ok') { realtimeOk = true; armTimers(); log('realtime suscrito'); }
      return;
    }
    if (event === 'postgres_changes') {
      const id = payload?.data?.record?.id;
      if (id) announced.add(id);
      log('realtime: nuevo trabajo creado', id);
      drainPending();
    }
  };
  sock.onerror = () => {};
  sock.onclose = () => {
    if (ws === sock) ws = null;
    realtimeOk = false;
    clearInterval(wsHeartbeat);
    armTimers();
    scheduleRealtimeReconnect();
  };
}

function closeRealtime() {
  clearTimeout(wsReconnect); wsReconnect = null;
  clearInterval(wsHeartbeat); wsHeartbeat = null;
  const sock = ws; ws = null; realtimeOk = false;
  try { sock?.close(); } catch {}
}

function armTimers() {
  clearInterval(heartbeatTimer); clearInterval(pollTimer); clearInterval(printerRefreshTimer);
  heartbeatTimer = setInterval(heartbeat, 30000);
  pollTimer = setInterval(drainPending, realtimeOk && realtimeTrusted ? SLOW_POLL_MS : FAST_POLL_MS);
  printerRefreshTimer = setInterval(refreshPrinters, 300000);
}

export async function startRunner(_cfg, _onStatus) {
  cfg = _cfg; onStatus = _onStatus || (() => {});
  await heartbeat();
  armTimers();
  connectRealtime();
  await drainPending();
}

// Al volver de segundo plano iOS congela los temporizadores: se rearman y se
// vacía la cola inmediatamente, sin recargar ni reconstruir nada.
export async function resumeRunner() {
  if (!cfg) return;
  armTimers();
  draining = false;
  if (!ws || ws.readyState > 1) { closeRealtime(); connectRealtime(); }
  await heartbeat();
  await drainPending();
}

export function isRunning() { return !!cfg; }

export async function stopRunner() {
  clearInterval(heartbeatTimer); clearInterval(pollTimer); clearInterval(printerRefreshTimer);
  closeRealtime();
  await closeSockets();
  cfg = null; seen.clear(); announced.clear(); printerCache.clear();
  draining = false; rerun = false; realtimeTrusted = true;
}

// -------- impresión --------
const RAW_KEYS = ['escposBase64', 'dataBase64', 'rawBase64', 'escpos_base64', 'raw_base64'];

function pickRawBase64(...sources) {
  for (const src of sources) {
    if (!src || typeof src !== 'object') continue;
    for (const k of RAW_KEYS) {
      const v = src[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
  }
  return null;
}

function fromBase64(b64) {
  const bin = atob(String(b64).replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// -------- normalización de bytes ESC/POS recibidos --------
// Comandero envía el ticket ya en ESC/POS pero codificado en UTF-8 (y con logo).
// Aquí se reconvierte a CP858 byte a byte (así se conservan €, tildes y la
// alineación de columnas) y se eliminan las imágenes/logo.
function isUtf8Start(b) { return b >= 0xC2 && b <= 0xF4; }
function utf8Len(b) { return b < 0xE0 ? 2 : b < 0xF0 ? 3 : 4; }

function isValidUtf8At(bytes, i, len) {
  if (i + len > bytes.length) return false;
  for (let n = 1; n < len; n++) {
    if (bytes[i + n] < 0x80 || bytes[i + n] > 0xBF) return false;
  }
  return true;
}

function copyBytes(out, bytes, start, length) {
  const end = Math.min(bytes.length, start + length);
  for (let n = start; n < end; n++) out.push(bytes[n]);
  return end;
}

// La nube puede enviar el ticket en UTF-8 o en Windows-1252 (1 byte por
// carácter). Se decide mirando el ticket COMPLETO: basta con un byte alto que
// no forme una secuencia UTF-8 válida para tratar todo el payload como 1252.
function detectEncoding(bytes) {
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i];
    if (b < 0x80) { i += 1; continue; }
    if (isUtf8Start(b) && isValidUtf8At(bytes, i, utf8Len(b))) { i += utf8Len(b); continue; }
    return 'cp1252';
  }
  return 'utf8';
}

// Caracteres Windows-1252 de la zona 0x80-0x9F (el resto coincide con Unicode).
const CP1252_HIGH = {
  0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„', 0x85: '…', 0x86: '†', 0x87: '‡',
  0x88: 'ˆ', 0x89: '‰', 0x8A: 'Š', 0x8B: '‹', 0x8C: 'Œ', 0x8E: 'Ž',
  0x91: '\u2018', 0x92: '\u2019', 0x93: '\u201C', 0x94: '\u201D', 0x95: '•',
  0x96: '\u2013', 0x97: '\u2014', 0x98: '˜', 0x99: '™', 0x9A: 'š', 0x9B: '›',
  0x9C: 'œ', 0x9E: 'ž', 0x9F: 'Ÿ',
};
// Traducción byte a byte Windows-1252 -> CP858 (misma longitud siempre).
let cp1252Table = null;
function cp1252ToCp858(b) {
  if (!cp1252Table) {
    cp1252Table = new Uint8Array(256);
    for (let n = 0; n < 256; n++) {
      cp1252Table[n] = n < 0x80 ? n : encodeChar(CP1252_HIGH[n] ?? String.fromCharCode(n));
    }
  }
  return cp1252Table[b];
}


function normalizeEscPos(bytes) {
  const out = [];
  const dec = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8', { fatal: true }) : null;
  const mode = detectEncoding(bytes);
  let i = 0;

  while (i < bytes.length) {
    const b = bytes[i];
    const b1 = bytes[i + 1], b2 = bytes[i + 2];

    // El ticket suele comenzar con ESC @. Se elimina porque, si se conserva
    // después de nuestra cabecera, resetea CP858 y hace desaparecer tildes/€.
    if (b === 0x1B && b1 === 0x40) { i += 2; continue; }

    // GS v 0 : imagen raster (logo) -> se descarta
    if (b === 0x1D && b1 === 0x76 && b2 === 0x30) {
      const xL = bytes[i + 4] || 0, xH = bytes[i + 5] || 0;
      const yL = bytes[i + 6] || 0, yH = bytes[i + 7] || 0;
      i += 8 + (xL + xH * 256) * (yL + yH * 256);
      continue;
    }
    // ESC * : imagen bit-image -> se descarta
    if (b === 0x1B && b1 === 0x2A) {
      const m = b2 || 0, nL = bytes[i + 3] || 0, nH = bytes[i + 4] || 0;
      const k = nL + nH * 256;
      i += 5 + (m === 32 || m === 33 ? k * 3 : k);
      continue;
    }
    // GS ( L / GS 8 L : gráficos almacenados -> se descarta
    if (b === 0x1D && b1 === 0x28 && b2 === 0x4C) {
      const pL = bytes[i + 3] || 0, pH = bytes[i + 4] || 0;
      i += 5 + pL + pH * 256;
      continue;
    }
    // ESC t n / ESC R n : la tabla de caracteres la fijamos nosotros
    if (b === 0x1B && (b1 === 0x74 || b1 === 0x52)) { i += 3; continue; }

    // Comandos de posicionamiento: sus parámetros son bytes binarios, no texto.
    // Se copian sin reinterpretarlos para conservar columnas y precios a derecha.
    if (b === 0x1B && (b1 === 0x24 || b1 === 0x5C)) { i = copyBytes(out, bytes, i, 4); continue; }
    if (b === 0x1D && (b1 === 0x4C || b1 === 0x57)) { i = copyBytes(out, bytes, i, 4); continue; }
    // Tabuladores horizontales: ESC D n1...nk NUL.
    if (b === 0x1B && b1 === 0x44) {
      do { out.push(bytes[i]); i += 1; } while (i < bytes.length && bytes[i - 1] !== 0x00);
      continue;
    }
    // Bloques GS ( k (QR) y otros GS ( x: pL/pH indican los bytes siguientes.
    if (b === 0x1D && b1 === 0x28 && i + 4 < bytes.length) {
      const length = 5 + bytes[i + 3] + bytes[i + 4] * 256;
      i = copyBytes(out, bytes, i, length);
      continue;
    }

    // Algunos tickets cobrados llegan separados sólo con CR. Muchas impresoras
    // térmicas lo interpretan como retorno al inicio de la misma línea y el texto
    // siguiente queda superpuesto. Unificamos CR, CRLF y LFCR como un único LF.
    if (b === 0x0D) {
      out.push(0x0A);
      i += b1 === 0x0A ? 2 : 1;
      continue;
    }
    if (b === 0x0A) {
      out.push(0x0A);
      i += b1 === 0x0D ? 2 : 1;
      continue;
    }

    if (b < 0x80) { out.push(b); i += 1; continue; }

    // Payload en Windows-1252: traducción directa 1 byte -> 1 byte.
    if (mode === 'cp1252') { out.push(cp1252ToCp858(b)); i += 1; continue; }

    if (isUtf8Start(b) && dec) {
      const len = utf8Len(b);
      if (!isValidUtf8At(bytes, i, len)) { out.push(b); i += 1; continue; }
      const slice = bytes.subarray(i, i + len);
      let ch = null;
      try { ch = dec.decode(slice); } catch { ch = null; }
      if (ch && ch.length) {
        for (const c of ch) out.push(encodeChar(c));

        i += len;
        continue;
      }
    }
    // ya venía en una codificación de 1 byte: se respeta tal cual
    out.push(b);
    i += 1;
  }

  // ESC @ + CP858 + España. La página 19 es la que usa el Bridge de escritorio
  // y contiene directamente todas las vocales acentuadas y el símbolo euro.
  const head = [0x1B, 0x40, 0x1B, 0x74, 0x13, 0x1B, 0x52, 0x07];
  return Uint8Array.from(head.concat(out));
}

// -------- diagnóstico temporal (invisible para el usuario) --------
// Envía al servidor un resumen de los bytes recibidos del ticket real.
// No altera en nada los bytes que se mandan a la impresora.
const DIAG_URL = 'https://bridge.comandero.online/api/public/bridge-diag';

function hexDump(bytes, from, to) {
  const parts = [];
  for (let i = Math.max(0, from); i < Math.min(bytes.length, to); i++) {
    parts.push(bytes[i].toString(16).padStart(2, '0'));
  }
  return parts.join(' ');
}

function findSeq(bytes, text) {
  const needle = [...text].map((c) => c.charCodeAt(0));
  outer: for (let i = 0; i + needle.length <= bytes.length; i++) {
    for (let n = 0; n < needle.length; n++) if (bytes[i + n] !== needle[n]) continue outer;
    return i;
  }
  return -1;
}

function reportDiag(bytes, job, path) {
  try {
    const high = [];
    for (let i = 0; i < bytes.length && high.length < 20; i++) {
      if (bytes[i] >= 0x80) high.push(`${i}:${bytes[i].toString(16).padStart(2, '0')}`);
    }
    const at = findSeq(bytes, 'Caf');
    const report = {
      jobId: job?.id ?? null,
      build: (typeof window !== 'undefined' && window.__BRIDGE_BUILD__) || null,
      path,
      totalBytes: bytes.length,
      hasHighBytes: high.length > 0,
      highBytes: high,
      cafIndex: at,
      cafHex: at >= 0 ? hexDump(bytes, at - 20, at + 40) : null,
      at: new Date().toISOString(),
    };
    fetch(DIAG_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(report),
      keepalive: true,
    }).catch(() => {});
  } catch {}
}

async function sendToPrinter(printer, payload, job) {
  // Si el trabajo ya trae los bytes ESC/POS, se reutilizan (sin regenerar el ticket),
  // normalizando codificación y quitando el logo.
  const raw = pickRawBase64(payload, job, job?.payload);
  let bytes;
  if (raw) {
    const src = fromBase64(raw);
    reportDiag(src, job, 'raw+normalizeEscPos');
    bytes = normalizeEscPos(src);
  } else {
    bytes = buildEscPos(payload || {}, printer.paper_width || 80, !!printer.auto_cut);
    reportDiag(bytes, job, 'buildEscPos');
  }
  return tcpPrint(printer.host, printer.port || 9100, bytes);
}


// Socket TCP persistente por impresora (host:puerto), reutilizado entre
// tickets y reconectado automáticamente si se cae.
const sockets = new Map();

async function getSocket(host, port, force) {
  const key = `${host}:${port}`;
  if (!force && sockets.has(key)) return { client: sockets.get(key), reused: true };
  if (sockets.has(key)) {
    const old = sockets.get(key);
    sockets.delete(key);
    try { await TcpSocket.disconnect({ client: old }); } catch {}
  }
  const { client } = await TcpSocket.connect({ ipAddress: String(host), port: Number(port) || 9100 });
  sockets.set(key, client);
  log('socket listo', key);
  return { client, reused: false };
}

async function closeSockets() {
  for (const [key, client] of [...sockets.entries()]) {
    sockets.delete(key);
    try { await TcpSocket.disconnect({ client }); } catch {}
  }
}

export async function tcpPrint(host, port, bytes) {
  if (!TcpSocket) throw new Error('Plugin TCP no disponible. Abre el Bridge desde la app instalada.');
  if (!host) throw new Error('La impresora no tiene IP configurada.');
  const data = toBase64(bytes);
  let sock = await getSocket(host, port, false);
  try {
    // Envío único, con los bytes en el mismo orden que hoy.
    await TcpSocket.send({ client: sock.client, data, encoding: 'base64' });
  } catch (e) {
    // El socket reutilizado estaba caído: reconectar y reenviar una sola vez.
    if (!sock.reused) throw e;
    sockets.delete(`${host}:${port}`);
    sock = await getSocket(host, port, true);
    await TcpSocket.send({ client: sock.client, data, encoding: 'base64' });
  }
  // Margen corto de seguridad para que la impresora reciba el bloque completo.
  await new Promise((r) => setTimeout(r, 120));
}

function toBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

// -------- ESC/POS + texto (idéntico al agente de escritorio) --------
const CP858_MAP = {
  'Ç':0x80,'ü':0x81,'é':0x82,'â':0x83,'ä':0x84,'à':0x85,'å':0x86,'ç':0x87,
  'ê':0x88,'ë':0x89,'è':0x8A,'ï':0x8B,'î':0x8C,'ì':0x8D,'Ä':0x8E,'Å':0x8F,
  'É':0x90,'æ':0x91,'Æ':0x92,'ô':0x93,'ö':0x94,'ò':0x95,'û':0x96,'ù':0x97,
  'ÿ':0x98,'Ö':0x99,'Ü':0x9A,'ø':0x9B,'£':0x9C,'Ø':0x9D,'×':0x9E,'ƒ':0x9F,
  'á':0xA0,'í':0xA1,'ó':0xA2,'ú':0xA3,'ñ':0xA4,'Ñ':0xA5,'ª':0xA6,'º':0xA7,
  '¿':0xA8,'®':0xA9,'¬':0xAA,'½':0xAB,'¼':0xAC,'¡':0xAD,'«':0xAE,'»':0xAF,
  'Á':0xB5,'Â':0xB6,'À':0xB7,'©':0xB8,'ã':0xC6,'Ã':0xC7,
  'ð':0xD0,'Ð':0xD1,'Ê':0xD2,'Ë':0xD3,'È':0xD4,'€':0xD5,'Í':0xD6,'Î':0xD7,'Ï':0xD8,'Ì':0xDE,
  'Ó':0xE0,'ß':0xE1,'Ô':0xE2,'Ò':0xE3,'õ':0xE4,'Õ':0xE5,'µ':0xE6,'þ':0xE7,'Þ':0xE8,
  'Ú':0xE9,'Û':0xEA,'Ù':0xEB,'ý':0xEC,'Ý':0xED,'¯':0xEE,'´':0xEF,
  '±':0xF1,'°':0xF8,'·':0xFA,'¹':0xFB,'³':0xFC,'²':0xFD,
};
const FALLBACK_MAP = {
  '\u00A0':0x20,'\u2013':0x2D,'\u2014':0x2D,'\u2018':0x27,'\u2019':0x27,
  '\u201C':0x22,'\u201D':0x22,'\u2026':0x2E,'\u202F':0x20,'\u2009':0x20,
};
// Si un carácter no existe en la tabla, se degrada a su equivalente sin tilde
// (misma anchura, nunca se pierde la letra).
const ASCII_FOLD = {
  'á':'a','à':'a','ä':'a','â':'a','ã':'a','å':'a','é':'e','è':'e','ë':'e','ê':'e',
  'í':'i','ì':'i','ï':'i','î':'i','ó':'o','ò':'o','ö':'o','ô':'o','õ':'o',
  'ú':'u','ù':'u','ü':'u','û':'u','ñ':'n','ç':'c','ý':'y',
  'Á':'A','À':'A','Ä':'A','Â':'A','Ã':'A','Å':'A','É':'E','È':'E','Ë':'E','Ê':'E',
  'Í':'I','Ì':'I','Ï':'I','Î':'I','Ó':'O','Ò':'O','Ö':'O','Ô':'O','Õ':'O',
  'Ú':'U','Ù':'U','Ü':'U','Û':'U','Ñ':'N','Ç':'C','º':'o','ª':'a','€':'E',
};
function encodeChar(ch) {
  const c = ch.charCodeAt(0);
  if (c < 0x80) return c;
  if (CP858_MAP[ch] != null) return CP858_MAP[ch];
  if (FALLBACK_MAP[ch] != null) return FALLBACK_MAP[ch];
  const folded = ASCII_FOLD[ch];
  if (folded) return folded.charCodeAt(0);
  return 0x3F;
}
function toCp858(str) {
  const out = [];
  for (const ch of String(str)) out.push(encodeChar(ch));
  return Uint8Array.from(out);
}

function pad(s, w) { s = String(s ?? ''); return s.length >= w ? s.slice(0, w) : s + ' '.repeat(w - s.length); }
function padLeft(s, w) { s = String(s ?? ''); return s.length >= w ? s.slice(0, w) : ' '.repeat(w - s.length) + s; }
function money(n) { return (Number(n) || 0).toFixed(2).replace('.', ',') + ' €'; }
function fmtDateEs() {
  try {
    return new Date().toLocaleString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch { return new Date().toISOString(); }
}
function renderText(p, widthMm) {
  const cols = widthMm === 58 ? 32 : 48;
  const lines = [];
  const center = (t) => { const s = String(t || ''); const n = Math.max(0, Math.floor((cols - s.length) / 2)); return ' '.repeat(n) + s; };
  const sep = '-'.repeat(cols);
  const h = p.header || {};
  if (h.businessName) lines.push(center(h.businessName));
  if (h.address) lines.push(center(h.address));
  if (h.phone) lines.push(center('Tel: ' + h.phone));
  if (h.taxId) lines.push(center('CIF: ' + h.taxId));
  lines.push('');
  lines.push(center('Factura simplificada'));
  lines.push('');
  if (h.orderNumber) lines.push(`Ticket: ${h.orderNumber}`);
  if (h.tableName) lines.push(`Mesa: ${h.tableName}`);
  lines.push(fmtDateEs(h.createdAt));
  lines.push(sep);
  for (const it of (p.lines || [])) {
    const left = `${it.qty}x ${it.name}`;
    const right = it.price != null ? money(Number(it.price) * Number(it.qty)) : '';
    lines.push(pad(left, cols - right.length) + right);
    if (it.modifiers?.length) for (const m of it.modifiers) lines.push('   + ' + m);
    if (it.notes) lines.push('   * ' + it.notes);
  }
  lines.push(sep);
  if (p.totals) {
    const W = 12;
    if (p.totals.subtotal != null) lines.push(pad('Subtotal', cols - W) + padLeft(money(p.totals.subtotal), W));
    if (p.totals.base != null) lines.push(pad('Base imponible', cols - W) + padLeft(money(p.totals.base), W));
    if (p.totals.tax != null) {
      const label = p.totals.vatRate != null ? `IVA (${p.totals.vatRate}%)` : 'IVA';
      lines.push(pad(label, cols - W) + padLeft(money(p.totals.tax), W));
    }
    lines.push(pad('TOTAL', cols - W) + padLeft(money(p.totals.total), W));
  }
  if (p.paymentMethod) { lines.push(''); lines.push(center(`Pago: ${p.paymentMethod}`)); }
  if (p.footer) { lines.push(''); for (const l of String(p.footer).split(/\r?\n/)) lines.push(center(l)); }
  return lines.join('\n') + '\n';
}
export function buildEscPos(p, widthMm, cut) {
  const body = toCp858(renderText(p, widthMm));
  // ESC @ (reset), ESC t 19 (CP858), ESC R 7 (España)
  const head = [0x1B, 0x40, 0x1B, 0x74, 0x13, 0x1B, 0x52, 0x07];
  // ESC d 5 (avanzar papel) antes de GS V 0 (corte)
  const tail = cut ? [0x1B, 0x64, 0x05, 0x1D, 0x56, 0x00] : [0x1B, 0x64, 0x05];
  const out = new Uint8Array(head.length + body.length + tail.length);
  out.set(head, 0);
  out.set(body, head.length);
  out.set(tail, head.length + body.length);
  return out;
}

export async function printTest(host, port) {
  const payload = {
    header: { businessName: 'COMANDERO BRIDGE', createdAt: new Date().toISOString() },
    lines: [{ qty: 1, name: 'Prueba de impresión', price: 0 }],
    totals: { total: 0 },
  };
  await tcpPrint(host, port || 9100, buildEscPos(payload, 80, true));
}

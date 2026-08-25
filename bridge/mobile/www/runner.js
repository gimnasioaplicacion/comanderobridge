// Comandero Bridge (móvil) — runner de impresión.
// Escucha la cola print_jobs en la nube y envía ESC/POS por TCP 9100
// usando el plugin nativo capacitor-tcp-socket (iOS + Android).

const TcpSocket = window.Capacitor?.Plugins?.TcpSocket;

let cfg = null;
let onStatus = () => {};
let heartbeatTimer = null;
let pollTimer = null;
const seen = new Set();

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

async function processJob(job) {
  if (!job || seen.has(job.id)) return;
  seen.add(job.id);
  const claimedRows = await rpc('agent_claim_job', {
    p_agent_id: cfg.agentId, p_pairing_code: String(cfg.pairingCode), p_job_id: job.id,
  });
  const claimed = Array.isArray(claimedRows) ? claimedRows[0] : null;
  if (!claimed) return;

  const printerRows = await rpc('agent_get_printer', {
    p_agent_id: cfg.agentId, p_pairing_code: String(cfg.pairingCode), p_printer_id: job.printer_id,
  });
  const printer = Array.isArray(printerRows) ? printerRows[0] : null;
  if (!printer) {
    await rpc('agent_finish_job', {
      p_agent_id: cfg.agentId, p_pairing_code: String(cfg.pairingCode), p_job_id: job.id,
      p_ok: false, p_error: 'Impresora no encontrada para este agente',
    });
    return;
  }
  try {
    await sendToPrinter(printer, job.payload);
    await rpc('agent_finish_job', {
      p_agent_id: cfg.agentId, p_pairing_code: String(cfg.pairingCode), p_job_id: job.id, p_ok: true,
    });
    setStatus({ lastJob: { id: job.id, ok: true, at: Date.now() } });
  } catch (e) {
    const msg = String(e?.message || e);
    await rpc('agent_finish_job', {
      p_agent_id: cfg.agentId, p_pairing_code: String(cfg.pairingCode), p_job_id: job.id, p_ok: false, p_error: msg,
    });
    setStatus({ lastJob: { id: job.id, ok: false, at: Date.now(), error: msg } });
  }
}

async function drainPending() {
  if (!cfg) return;
  try {
    const data = await rpc('agent_pending_jobs', {
      p_agent_id: cfg.agentId, p_pairing_code: String(cfg.pairingCode), p_limit: 50,
    });
    for (const j of (data ?? [])) await processJob(j);
  } catch (e) {
    setStatus({ online: false, error: String(e?.message || e) });
  }
}

export async function startRunner(_cfg, _onStatus) {
  cfg = _cfg; onStatus = _onStatus || (() => {});
  await heartbeat();
  heartbeatTimer = setInterval(heartbeat, 30000);
  pollTimer = setInterval(drainPending, 900);
  await drainPending();
}

export async function stopRunner() {
  clearInterval(heartbeatTimer); clearInterval(pollTimer);
  cfg = null; seen.clear();
}

// -------- impresión --------
async function sendToPrinter(printer, payload) {
  const bytes = buildEscPos(payload, printer.paper_width || 80, !!printer.auto_cut);
  return tcpPrint(printer.host, printer.port || 9100, bytes);
}

export async function tcpPrint(host, port, bytes) {
  if (!TcpSocket) throw new Error('Plugin TCP no disponible. Abre el Bridge desde la app instalada.');
  if (!host) throw new Error('La impresora no tiene IP configurada.');
  const { client } = await TcpSocket.connect({ ipAddress: String(host), port: Number(port) || 9100 });
  try {
    await TcpSocket.send({ client, data: toBase64(bytes), encoding: 'base64' });
  } finally {
    try { await TcpSocket.disconnect({ client }); } catch {}
  }
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
  '±':0xF1,'·':0xFA,'¹':0xFB,'³':0xFC,'²':0xFD,
  '\u00A0':0x20,'\u2013':0x2D,'\u2014':0x2D,'\u2018':0x27,'\u2019':0x27,'\u201C':0x22,'\u201D':0x22,'\u2026':0x2E,
};
function toCp858(str) {
  const out = [];
  for (const ch of String(str)) {
    const c = ch.charCodeAt(0);
    if (c < 0x80) out.push(c);
    else if (CP858_MAP[ch] != null) out.push(CP858_MAP[ch]);
    else out.push(0x3F);
  }
  return Uint8Array.from(out);
}
function pad(s, w) { s = String(s ?? ''); return s.length >= w ? s.slice(0, w) : s + ' '.repeat(w - s.length); }
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
    if (p.totals.subtotal != null) lines.push(pad('Subtotal', cols - W) + pad(money(p.totals.subtotal), W));
    if (p.totals.base != null) lines.push(pad('Base imponible', cols - W) + pad(money(p.totals.base), W));
    if (p.totals.tax != null) {
      const label = p.totals.vatRate != null ? `IVA (${p.totals.vatRate}%)` : 'IVA';
      lines.push(pad(label, cols - W) + pad(money(p.totals.tax), W));
    }
    lines.push(pad('TOTAL', cols - W) + pad(money(p.totals.total), W));
  }
  if (p.paymentMethod) { lines.push(''); lines.push(center(`Pago: ${p.paymentMethod}`)); }
  if (p.footer) { lines.push(''); for (const l of String(p.footer).split(/\r?\n/)) lines.push(center(l)); }
  return lines.join('\n') + '\n';
}
export function buildEscPos(p, widthMm, cut) {
  const body = toCp858(renderText(p, widthMm));
  const head = [0x1B, 0x40, 0x1B, 0x74, 19, 0x1B, 0x52, 0x07];
  const tail = cut ? [0x1B, 0x33, 0x00, 0x1D, 0x56, 0x01] : [];
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
    footer: 'Si lees esto, el agente funciona ✓',
  };
  await tcpPrint(host, port || 9100, buildEscPos(payload, 80, true));
}

import { startRunner, stopRunner, restRequestWith, printTest } from './runner.js';

const SB_URL = 'https://mfzutyocbmwcjjiywzsn.supabase.co';
const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1menV0eW9jYm13Y2pqaXl3enNuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc0NTQ5NzQsImV4cCI6MjA5MzAzMDk3NH0.INDptBoWSFJ7dJ_j8ipUq3KYMp4V82eRG_iZN0Isg-w';
const VERSION = '1.0.2';
const KEY = 'comandero-bridge-config';

const $ = (id) => document.getElementById(id);

// Persistencia nativa (sobrevive al cierre de la app en iOS/Android) con
// respaldo en localStorage para la vista previa web.
const prefs = () => window.Capacitor?.Plugins?.Preferences || null;
async function loadConfig() {
  try {
    const p = prefs();
    if (p) {
      const { value } = await p.get({ key: KEY });
      if (value) {
        try { localStorage.setItem(KEY, value); } catch {}
        return JSON.parse(value);
      }
      // Migración: si nativo está vacío pero hay algo en localStorage, súbelo.
      const legacy = localStorage.getItem(KEY);
      if (legacy) {
        try { await p.set({ key: KEY, value: legacy }); } catch {}
        return JSON.parse(legacy);
      }
      return null;
    }
  } catch {}
  try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return null; }
}
async function saveConfig(c) {
  const raw = JSON.stringify(c);
  try { localStorage.setItem(KEY, raw); } catch {}
  try { await prefs()?.set({ key: KEY, value: raw }); } catch {}
}
async function clearConfig() {
  try { localStorage.removeItem(KEY); } catch {}
  try { await prefs()?.remove({ key: KEY }); } catch {}
}

$('ver').textContent = VERSION;

function renderStatus(status) {
  const cls = 'dot' + (status.online ? ' on' : status.error ? ' err' : '');
  const dot = $('dot');
  dot.className = cls;
  const dotTop = $('dotTop');
  if (dotTop) dotTop.className = cls;
  $('statusText').textContent = status.online ? 'Conectado a la nube' : (status.error || 'Conectando…');
  const j = status.lastJob;
  $('lastJob').textContent = j
    ? `Último ticket: ${j.ok ? 'impreso' : 'error — ' + (j.error || '')} (${new Date(j.at).toLocaleTimeString('es-ES')})`
    : 'Sin tickets todavía.';
}

let status = { online: false, lastJob: null, error: null };

async function boot() {
  const cfg = await loadConfig();
  if (cfg?.agentId && cfg?.pairingCode) {
    $('unpaired').style.display = 'none';
    $('paired').style.display = 'block';
    $('subtitle').textContent = 'Agente vinculado';
    renderStatus(status);
    await startRunner(
      { ...cfg, supabaseUrl: SB_URL, supabaseKey: SB_KEY, version: VERSION, platform: window.Capacitor?.getPlatform?.() || 'mobile' },
      (s) => { status = { ...status, ...s }; renderStatus(status); },
    );
  } else {
    $('unpaired').style.display = 'block';
    $('paired').style.display = 'none';
    $('subtitle').textContent = 'Sin vincular';
  }
}

$('pairBtn').onclick = async () => {
  const btn = $('pairBtn');
  const err = $('pairErr');
  err.textContent = '';
  const pairingCode = String($('code').value || '').replace(/\D/g, '');
  if (pairingCode.length !== 6) { err.textContent = 'Introduce el código de 6 dígitos.'; return; }
  btn.disabled = true;
  try {
    const rows = await restRequestWith(SB_URL, SB_KEY, 'GET', `print_agents?select=*&pairing_code=eq.${encodeURIComponent(pairingCode)}&limit=1`);
    const data = Array.isArray(rows) ? rows[0] : null;
    if (!data) throw new Error('Código no encontrado o caducado');
    if (data.pairing_expires_at && new Date(data.pairing_expires_at) < new Date()) {
      throw new Error('El código ha caducado. Pide uno nuevo en la app.');
    }
    await restRequestWith(SB_URL, SB_KEY, 'PATCH', `print_agents?id=eq.${encodeURIComponent(data.id)}&pairing_code=eq.${encodeURIComponent(pairingCode)}`, {
      paired_at: new Date().toISOString(),
      last_heartbeat: new Date().toISOString(),
      platform: window.Capacitor?.getPlatform?.() || 'mobile',
      version: VERSION,
    });
    await saveConfig({ agentId: data.id, restaurantId: data.restaurant_id, pairingCode });
    await stopRunner();
    status = { online: false, lastJob: null, error: null };
    await boot();
  } catch (e) {
    err.textContent = String(e?.message || e);
  } finally {
    btn.disabled = false;
  }
};

$('unpairBtn').onclick = async () => {
  await stopRunner();
  await clearConfig();
  status = { online: false, lastJob: null, error: null };
  await boot();
};

$('testBtn').onclick = async () => {
  const msg = $('testMsg');
  msg.className = 'muted';
  msg.textContent = 'Enviando…';
  try {
    await printTest($('testHost').value.trim(), Number($('testPort').value) || 9100);
    msg.className = 'ok';
    msg.textContent = 'Prueba enviada correctamente.';
  } catch (e) {
    msg.className = 'err';
    msg.textContent = String(e?.message || e);
  }
};

boot();

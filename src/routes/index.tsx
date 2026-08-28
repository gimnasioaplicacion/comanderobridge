import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";

const bridgeStyles = `
  :root { color-scheme: dark; font-family: -apple-system, system-ui, "Segoe UI", sans-serif; }
  html, body, #root { height: 100%; }
  body { margin: 0; background: #0f172a; color: #e2e8f0; overflow: hidden; }
  .shell { position: relative; width: 100vw; height: 100vh; overflow: hidden; }
  #webPane { position: absolute; inset: 0; z-index: 1; }
  #webPane iframe { width: 100%; height: 100%; border: 0; background: #fff; }
  .agentHotspot {
    position: absolute;
    top: max(6px, env(safe-area-inset-top));
    left: 6px;
    z-index: 30;
    width: 18px;
    height: 18px;
    padding: 0;
    border-radius: 50%;
    background: rgba(11, 18, 32, 0.18);
    border: 1px solid rgba(148, 163, 184, 0.15);
    color: #e2e8f0;
    font-size: 10px;
    line-height: 1;
    opacity: 0.35;
    display: flex;
    align-items: center;
    justify-content: center;
    -webkit-tap-highlight-color: transparent;
    pointer-events: auto;
  }
  .agentHotspot .dot { width: 6px; height: 6px; }
  .agentOverlay {
    position: absolute;
    inset: 0;
    z-index: 20;
    background: rgba(15, 23, 42, 0.96);
    display: flex;
    flex-direction: column;
    padding: max(16px, env(safe-area-inset-top)) 16px max(16px, env(safe-area-inset-bottom));
  }
  .agentHeader {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 16px;
    flex: none;
  }
  .agentHeader h1 { margin: 0; font-size: 20px; }
  .agentHeader .closeBtn {
    width: auto;
    padding: 8px 14px;
    background: transparent;
    border: 1px solid #475569;
    color: #e2e8f0;
    border-radius: 8px;
    font-size: 13px;
  }
  .agentScroll { flex: 1; overflow: auto; min-height: 0; }
  .agentContent { max-width: 520px; margin: 0 auto; }
  .muted { color: #94a3b8; font-size: 13px; }
  .card { background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 16px; margin-top: 16px; }
  label { display: block; font-size: 12px; color: #94a3b8; margin-bottom: 6px; }
  input { width: 100%; padding: 12px; background: #0f172a; color: #e2e8f0; border: 1px solid #334155; border-radius: 8px; box-sizing: border-box; font-size: 16px; }
  button { width: 100%; padding: 12px 16px; background: #e2552b; color: #fff; border: 0; border-radius: 8px; font-size: 15px; font-weight: 600; }
  button.secondary { background: transparent; border: 1px solid #475569; color: #e2e8f0; }
  .row { display: flex; gap: 8px; align-items: center; }
  .dot { width: 10px; height: 10px; border-radius: 50%; background: #64748b; display: inline-block; }
  .dot.on { background: #22c55e; } .dot.err { background: #ef4444; }
  .err { color: #f87171; font-size: 12px; margin-top: 8px; }
  .ok { color: #4ade80; font-size: 12px; margin-top: 8px; }
  .grid2 { display: grid; grid-template-columns: 1fr 110px; gap: 8px; }
  .sp { height: 12px; }
`;


export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Comandero Bridge" },
      {
        name: "description",
        content:
          "Agente local de impresión Comandero Bridge: vincula el dispositivo y envía tickets ESC/POS a impresoras de red.",
      },
      { property: "og:title", content: "Comandero Bridge" },
      {
        property: "og:description",
        content:
          "Agente local de impresión Comandero Bridge: vincula el dispositivo y envía tickets ESC/POS a impresoras de red.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    styles: [{ children: bridgeStyles }],
  }),
  component: BridgeApp,
});

function BridgeApp() {
  const [agentOpen, setAgentOpen] = useState(false);

  useEffect(() => {
    const s = document.createElement("script");
    s.type = "module";
    s.src = "/app.js";
    document.body.appendChild(s);
    return () => {
      s.remove();
    };
  }, []);

  return (
    <div className="shell">
      <div id="webPane">
        <iframe
          id="posFrame"
          title="Comandero"
          src="https://pos.comandero.online"
          allow="clipboard-read; clipboard-write; camera; fullscreen"
        />
      </div>

      <button
        type="button"
        className="agentHotspot"
        onClick={() => setAgentOpen(true)}
        aria-label="Abrir agente de impresión"
      >
        <span className="dot" id="dotTop" />
      </button>

      <div className="agentOverlay" style={{ display: agentOpen ? "flex" : "none" }}>
          <div className="agentHeader">
            <h1>Agente de impresión</h1>
            <button
              type="button"
              className="closeBtn"
              onClick={() => setAgentOpen(false)}
            >
              Cerrar
            </button>
          </div>

          <div className="agentScroll">
            <div className="agentContent">
              <div className="muted">
                <span id="subtitle">Cargando…</span> · v<span id="ver">1.0.0</span>
              </div>

              <div id="unpaired" className="card" style={{ display: "none" }}>
                <label htmlFor="code">Código de emparejamiento (6 dígitos)</label>
                <input id="code" maxLength={6} inputMode="numeric" placeholder="123456" />
                <div className="sp" />
                <button id="pairBtn">Vincular</button>
                <div id="pairErr" className="err" />
                <p className="muted">
                  Pídelo en la app web:{" "}
                  <strong>Admin → Impresoras → Agentes locales → Vincular nuevo agente</strong>.
                </p>
              </div>

              <div id="paired" className="card" style={{ display: "none" }}>
                <div className="row">
                  <span className="dot" id="dot" />
                  <strong id="statusText">Iniciando…</strong>
                </div>
                <div className="muted" id="lastJob" style={{ marginTop: 6 }} />
                <div className="sp" />
                <div className="muted">
                  Comandero se abre dentro de esta app, así el agente nunca queda en segundo
                  plano. Las impresoras WiFi/LAN se configuran en Comandero con su IP y puerto
                  9100.
                </div>
                <div className="sp" />
                <label htmlFor="testHost">Probar impresora de red por IP</label>
                <div className="grid2">
                  <input id="testHost" placeholder="192.168.1.50" />
                  <input id="testPort" type="number" defaultValue={9100} />
                </div>
                <div className="sp" />
                <button className="secondary" id="testBtn">
                  Imprimir prueba por IP
                </button>
                <div id="testMsg" />
                <div className="sp" />
                <button className="secondary" id="unpairBtn">
                  Desvincular este agente
                </button>
              </div>
            </div>
          </div>
      </div>
    </div>
  );
}

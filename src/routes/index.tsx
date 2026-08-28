import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";

const bridgeStyles = `
  :root { color-scheme: dark; font-family: -apple-system, system-ui, "Segoe UI", sans-serif; }
  html, body, #root { height: 100%; }
  body { margin: 0; background: #0f172a; color: #e2e8f0; overflow: hidden; }
  .shell { display: flex; flex-direction: column; height: 100vh; }
  header.topbar { display: flex; align-items: center; gap: 10px; padding: max(10px, env(safe-area-inset-top)) 14px 10px; background: #0b1220; border-bottom: 1px solid #1e293b; flex: none; }
  .brand { font-size: 15px; font-weight: 700; }
  .tabs { margin-left: auto; display: flex; gap: 6px; }
  .tabs button { width: auto; padding: 8px 14px; font-size: 13px; background: transparent; border: 1px solid #334155; color: #cbd5e1; border-radius: 8px; }
  .tabs button.active { background: #e2552b; border-color: #e2552b; color: #fff; }
  main.panes { flex: 1; position: relative; min-height: 0; }
  .pane { position: absolute; inset: 0; }
  .pane[hidden] { display: none; }
  #webPane iframe { width: 100%; height: 100%; border: 0; background: #fff; }
  #bridgePane { overflow: auto; padding: 16px 20px 24px; box-sizing: border-box; }
  h1 { margin: 0 0 4px; font-size: 22px; }
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
  const [tab, setTab] = useState<"web" | "bridge">("web");

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
      <header className="topbar">
        <span className="dot" id="dotTop" />
        <span className="brand">Comandero Bridge</span>
        <nav className="tabs">
          <button
            type="button"
            className={tab === "web" ? "active" : undefined}
            onClick={() => setTab("web")}
          >
            Comandero
          </button>
          <button
            type="button"
            className={tab === "bridge" ? "active" : undefined}
            onClick={() => setTab("bridge")}
          >
            Agente
          </button>
        </nav>
      </header>

      <main className="panes">
        <section id="webPane" className="pane" hidden={tab !== "web"}>
          <iframe
            id="posFrame"
            title="Comandero"
            src="https://pos.comandero.online"
            allow="clipboard-read; clipboard-write; camera; fullscreen"
          />
        </section>

        <section id="bridgePane" className="pane" hidden={tab !== "bridge"}>
          <h1>Agente de impresión</h1>
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
        </section>
      </main>
    </div>
  );
}


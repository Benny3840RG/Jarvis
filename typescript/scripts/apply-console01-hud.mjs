import { readFileSync, writeFileSync } from "node:fs";

const path = new URL("../src/mcp/dashboard-v1.html", import.meta.url);
let html = readFileSync(path, "utf8");

if (html.includes("data-console-skin=\"console-01\"")) {
  console.log("Console 01 HUD already applied.");
  process.exit(0);
}

html = html
  .replace("<title>Jarvis // Operator Console</title>", "<title>Jarvis Systems // Console 01</title>")
  .replace(
    '<div class="mark" aria-hidden="true">J</div>',
    `<div class="mark mascot-mark" data-console-skin="console-01" aria-hidden="true">
      <svg viewBox="0 0 64 64" focusable="false">
        <path d="M21 13h22l5 10v19c0 8-7 14-16 14s-16-6-16-14V23z" fill="#d9dde6" stroke="#05060a" stroke-width="3"/>
        <path d="M22 15l4-8h12l4 8" fill="none" stroke="#ff9a35" stroke-width="4" stroke-linecap="round"/>
        <ellipse cx="26" cy="31" rx="5" ry="8" fill="#070912"/><ellipse cx="39" cy="31" rx="5" ry="8" fill="#070912"/>
        <circle cx="27" cy="29" r="2" fill="#b933ff"/><circle cx="40" cy="29" r="2" fill="#39e6ff"/>
        <path d="M24 43c5 5 12 5 17 0" fill="none" stroke="#070912" stroke-width="3" stroke-linecap="round"/>
        <path d="M16 25h-5v13h5M48 25h5v13h-5" fill="#7a8294" stroke="#05060a" stroke-width="3"/>
      </svg>
    </div>`,
  )
  .replace("<h1>JARVIS // OPERATOR CONSOLE</h1>", "<h1>JARVIS SYSTEMS // CONSOLE 01</h1>")
  .replace(
    '<div class="mission-copy">',
    `<div class="mission-mascot" aria-hidden="true">
      <svg viewBox="0 0 180 180" focusable="false">
        <path d="M57 42h66l14 30v45c0 25-21 44-47 44s-47-19-47-44V72z" fill="#d8dde8" stroke="#06070c" stroke-width="8"/>
        <path d="M60 45l12-25h36l12 25" fill="none" stroke="#ff9a35" stroke-width="10" stroke-linecap="round"/>
        <path d="M71 22h38" stroke="#39e6ff" stroke-width="5" stroke-linecap="round"/>
        <ellipse cx="73" cy="91" rx="14" ry="22" fill="#070912"/><ellipse cx="108" cy="91" rx="14" ry="22" fill="#070912"/>
        <ellipse cx="77" cy="84" rx="5" ry="8" fill="#b933ff"/><ellipse cx="112" cy="84" rx="5" ry="8" fill="#39e6ff"/>
        <circle cx="90" cy="111" r="7" fill="#070912"/>
        <path d="M67 127c13 14 33 14 46 0" fill="none" stroke="#070912" stroke-width="8" stroke-linecap="round"/>
        <path d="M44 76H31v39h13M136 76h13v39h-13" fill="#778093" stroke="#06070c" stroke-width="8"/>
      </svg>
    </div>
    <div class="mission-copy">`,
  );

const css = `
      /* Console 01 visual master: industrial cartoon reactor HUD. */
      :root { --console-cyan:#39e6ff; --console-cyan-soft:rgba(57,230,255,.14); --console-amber:#ffb25b; --console-steel:#202634; }
      body { background:radial-gradient(circle at 50% 30%,rgba(57,230,255,.09),transparent 34rem),radial-gradient(circle at 15% 0%,rgba(185,51,255,.18),transparent 30rem),radial-gradient(circle at 95% 70%,rgba(255,122,24,.12),transparent 34rem),#05060a; }
      .hud-frame { position:relative; border:2px solid #32394a; border-radius:24px; background:linear-gradient(145deg,#090b11,#05060a 60%,#0b0d13); box-shadow:0 28px 90px rgba(0,0,0,.62),inset 0 0 0 2px #111520,inset 0 0 55px rgba(57,230,255,.035); clip-path:polygon(1.2% 0,98.8% 0,100% 2.2%,100% 97.8%,98.8% 100%,1.2% 100%,0 97.8%,0 2.2%); }
      .hud-frame::before,.hud-frame::after { content:""; position:absolute; z-index:20; width:130px; height:16px; pointer-events:none; background:repeating-linear-gradient(90deg,#ff7a18 0 13px,#111520 13px 20px); box-shadow:0 0 18px rgba(255,122,24,.28); }
      .hud-frame::before { top:0; left:8%; } .hud-frame::after { right:8%; bottom:0; }
      .top-glow { height:4px; background:linear-gradient(90deg,#ff7a18,#ffb25b,#b933ff,#39e6ff,#39ff88); }
      .topbar { background:linear-gradient(180deg,#151a24,#090b11); border-bottom-color:#3a4254; }
      .mascot-mark { width:54px; height:54px; border-color:rgba(255,178,91,.7); background:radial-gradient(circle,rgba(57,230,255,.15),transparent 60%),#0a0d14; }
      .mascot-mark::before,.mascot-mark::after { display:none; } .mascot-mark svg { width:48px; height:48px; filter:drop-shadow(0 0 8px rgba(57,230,255,.28)); }
      .brand h1 { color:#f6f3e9; text-shadow:0 0 14px rgba(255,178,91,.18); } .brand p b { color:var(--console-amber); }
      .panel,.section-card,.mission-core,.queue-panel { border-color:#343b4c; background:linear-gradient(145deg,rgba(25,30,42,.97),rgba(7,9,14,.99)); box-shadow:inset 0 0 0 1px rgba(255,255,255,.025),inset 0 0 32px rgba(57,230,255,.025); }
      .panel::after,.section-card::after,.mission-core::before,.queue-panel::after { content:""; position:absolute; inset:5px; pointer-events:none; border:1px solid rgba(255,178,91,.06); border-radius:10px; }
      .panel-header,.section-head,.mission-heading { background:linear-gradient(90deg,rgba(255,122,24,.08),rgba(185,51,255,.08),rgba(57,230,255,.06)); }
      .violet-edge { border-color:rgba(185,51,255,.5); } .green-edge { border-color:rgba(57,230,255,.42); }
      .telemetry-strip { background:linear-gradient(180deg,#10141d,#080a10); }
      .telemetry-item:nth-child(3n+1) b { color:var(--console-amber); } .telemetry-item:nth-child(3n+2) b { color:var(--console-cyan); } .telemetry-item:nth-child(3n) b { color:#c77dff; }
      .mission-visual::before,.mission-visual::after { content:""; position:absolute; width:54%; height:3px; top:50%; left:23%; z-index:0; background:linear-gradient(90deg,transparent,var(--console-cyan),#fff,var(--violet),transparent); filter:blur(.3px) drop-shadow(0 0 8px var(--console-cyan)); opacity:.52; transform:rotate(-11deg); }
      .mission-visual::after { transform:rotate(13deg); opacity:.34; }
      .mission-ring { width:min(360px,80%); filter:drop-shadow(0 0 18px rgba(57,230,255,.15)); }
      .mission-ring::before { content:""; position:absolute; inset:10%; border-radius:50%; background:conic-gradient(from 20deg,rgba(255,122,24,.16),rgba(185,51,255,.18),rgba(57,230,255,.18),rgba(57,255,136,.13),rgba(255,122,24,.16)); box-shadow:inset 0 0 28px rgba(0,0,0,.78),0 0 28px rgba(57,230,255,.12); }
      .mission-mascot { position:absolute; z-index:3; inset:25% 25% 31%; display:grid; place-items:center; pointer-events:none; }
      .mission-mascot svg { width:100%; max-height:100%; filter:drop-shadow(0 0 10px rgba(57,230,255,.35)) drop-shadow(0 0 8px rgba(185,51,255,.25)); }
      .mission-copy { z-index:4; inset:66% 13% 8%; place-content:start center; padding-top:4px; }
      .mission-copy h2 { font-size:clamp(13px,1.5vw,20px); -webkit-line-clamp:2; } .mission-copy p { color:var(--console-cyan); }
      .core-gauge { filter:drop-shadow(0 0 12px rgba(57,230,255,.12)); }
      .rail-icon,.capture-tab.active,.primary-button { border-color:var(--console-amber); }
      .rail-button.active { border-left-color:var(--console-amber); background:linear-gradient(90deg,rgba(255,122,24,.15),rgba(185,51,255,.08)); }
      .rail-button.active .rail-icon { color:var(--console-amber); }
      .primary-button,.capture-submit { background:linear-gradient(90deg,#ff8a28,#ffb25b); color:#100a04; box-shadow:0 0 18px rgba(255,122,24,.22); }
      .bar-fill { background:linear-gradient(90deg,var(--violet),var(--console-cyan),var(--console-amber)); }
      .footer-stream { background:linear-gradient(180deg,#111620,#080a0f); border-top-color:#3d4558; }
      @media (max-width:760px) { .mission-mascot { inset:27% 28% 33%; } .hud-frame { clip-path:none; } }
`;

html = html.replace("</style>", `${css}</style>`);
html = html.replace("<body>", "<body><!-- JARVIS // OPERATOR CONSOLE · LANDSCAPE COMMAND CENTRE -->");

writeFileSync(path, html);
console.log("Applied Jarvis Console 01 HUD skin.");

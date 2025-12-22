const express = require("express");
const bodyParser = require("body-parser");
const { spawn } = require("child_process");
const path = require("path"); // ✅ FIX CIRÚRGICO — path não estava importado
const http = require("http");
const net = require("net");
const { URL } = require("url");

console.log("[BOOT] Processo iniciando…");
console.log("[BOOT] NODE_ENV:", process.env.NODE_ENV);
console.log("[BOOT] PORT env:", process.env.PORT);
console.log("[BOOT] PID:", process.pid);

process.on("SIGTERM", () => {
  console.error("[SIGNAL] SIGTERM recebido — processo sendo finalizado");
  process.exit(0);
});

process.on("SIGINT", () => {
  console.error("[SIGNAL] SIGINT recebido");
  process.exit(0);
});

process.on("exit", (code) => {
  console.error("[EXIT] Processo saindo com code:", code);
});

const app = express();
app.use(bodyParser.json({ limit: "10mb" }));

// ======================================================
// STATIC FILES (noVNC)
// ======================================================
const NOVNC_PATH = path.resolve(process.cwd(), "public/novnc");

/**
 * ✅ FIX CANÔNICO:
 * O noVNC (vnc.html) estava tentando conectar em wss://HOST:6080/websockify.
 * Como 6080 é interno (não exposto no Fly), isso sempre vai falhar.
 *
 * Aqui nós forçamos o noVNC a:
 * - usar port 443
 * - usar path /novnc/websockify
 *
 * E o proxy WebSocket é feito no "upgrade" do servidor HTTP (abaixo),
 * encaminhando para ws://127.0.0.1:6080 (websockify interno).
 *
 * ✅ MUDANÇA MÍNIMA AQUI:
 * - Este handler precisa vir ANTES do express.static
 * - E precisa capturar /novnc e /novnc/ (barra no fim)
 */
app.get(["/novnc", "/novnc/"], (req, res) => {
  // 🔑 GARANTIA: VNC precisa estar ativo antes do browser tentar WS
  if (!status().running) {
    try {
      console.log("[AUTO] iniciando VNC automaticamente");
      startVncStack();
    } catch (e) {
      console.error("[AUTO] falha ao iniciar VNC:", e);
    }
  }

  const host = req.hostname;

  // Fly termina TLS e repassa pra nós; usamos x-forwarded-proto quando disponível.
  const xfProto = req.headers["x-forwarded-proto"];
  const proto = typeof xfProto === "string" ? xfProto : "https";

  // Para o cliente, a porta pública é 443 (https) ou 80 (http).
  const publicPort = proto === "http" ? 80 : 443;

  const qs =
    `host=${encodeURIComponent(host)}` +
    `&port=${encodeURIComponent(String(publicPort))}` +
    `&path=${encodeURIComponent("novnc/websockify")}` +
    `&password=${encodeURIComponent("3487")}` +
    `&autoconnect=1`;

  // vnc.html fica dentro do /novnc por causa do static abaixo
  res.redirect(`/novnc/vnc.html?${qs}`);
});

/**
 * ✅ MUDANÇA MÍNIMA:
 * static vem DEPOIS do redirect, senão /novnc/ cai no index.html do noVNC
 * e ignora nosso querystring.
 */
app.use("/novnc", express.static(NOVNC_PATH));

// ======================================================
// CONFIG VNC
// ======================================================
const ADMIN_TOKEN = process.env.ENAVIA_VNC_ADMIN_TOKEN || "";
const VNC_PASSWORD = process.env.VNC_PASSWORD || "";
const VNC_DISPLAY = process.env.VNC_DISPLAY || ":99";
const VNC_RESOLUTION = process.env.VNC_RESOLUTION || "1280x720";
const VNC_DEPTH = process.env.VNC_DEPTH || "24";
const VNC_PORT = Number(process.env.VNC_PORT || 5900);
const VNC_WS_PORT = Number(process.env.VNC_WS_PORT || 6080);

let xvfbProc = null;
let x11vncProc = null;
let websockifyProc = null;

// ======================================================
// HELPERS
// ======================================================
function isRunning(p) {
  return p && p.pid && !p.killed;
}

function status() {
  return {
    running:
      isRunning(xvfbProc) &&
      isRunning(x11vncProc) &&
      isRunning(websockifyProc),
    display: VNC_DISPLAY,
    vnc_port: VNC_PORT,
    ws_port: VNC_WS_PORT,
  };
}

function killProc(p, name) {
  if (!p) return;
  try {
    console.log("[VNC] encerrando " + name + " pid=" + p.pid);
    p.kill("SIGTERM");
  } catch (e) {
    const msg = e && e.message ? e.message : e;
    console.error("[VNC] erro ao encerrar " + name + ":", msg);
  }
}

function startVncStack() {
  if (!VNC_PASSWORD) {
    throw new Error("VNC_PASSWORD não definido");
  }

  console.log("[VNC] iniciando stack");

    // 1) Xvfb
  xvfbProc = spawn(
    "Xvfb",
    [
      VNC_DISPLAY,
      "-screen",
      "0",
      VNC_RESOLUTION + "x" + VNC_DEPTH,
      "-ac",
      "-nolisten",
      "tcp",
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  );

  if (xvfbProc.stderr) {
    xvfbProc.stderr.on("data", (d) => {
      console.log("[Xvfb]", d.toString().trim());
    });
  }

  // ✅ INICIAR AMBIENTE GRÁFICO APÓS Xvfb (CORREÇÃO CANÔNICA)
  spawn("openbox", [], {
    env: { ...process.env, DISPLAY: VNC_DISPLAY },
    stdio: "ignore",
    detached: true,
  });

  spawn("xterm", [], {
    env: { ...process.env, DISPLAY: VNC_DISPLAY },
    stdio: "ignore",
    detached: true,
  });

  // 2) x11vnc
  x11vncProc = spawn(
    "x11vnc",
    [
      "-display",
      VNC_DISPLAY,
      "-rfbport",
      String(VNC_PORT),
      "-passwd",
      VNC_PASSWORD,
      "-forever",
      "-shared",
      "-noxdamage",
      "-quiet",
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  );

  if (x11vncProc.stderr) {
    x11vncProc.stderr.on("data", (d) => {
      console.log("[x11vnc]", d.toString().trim());
    });
  }

  // 3) websockify
  websockifyProc = spawn(
    "websockify",
    [String(VNC_WS_PORT), "127.0.0.1:" + VNC_PORT],
    { stdio: ["ignore", "pipe", "pipe"] }
  );

  if (websockifyProc.stderr) {
    websockifyProc.stderr.on("data", (d) => {
      console.log("[websockify]", d.toString().trim());
    });
  }
}

function stopVncStack() {
  console.log("[VNC] encerrando stack");
  killProc(websockifyProc, "websockify");
  killProc(x11vncProc, "x11vnc");
  killProc(xvfbProc, "Xvfb");
  websockifyProc = null;
  x11vncProc = null;
  xvfbProc = null;
}

// ======================================================
// AUTH (TEMPORÁRIO)
// ======================================================
function requireAdmin(req, res) {
  const token = req.headers["x-enavia-token"];
  if (!ADMIN_TOKEN || token !== ADMIN_TOKEN) {
    res.status(401).json({ ok: false, error: "unauthorized" });
    return false;
  }
  return true;
}

// ======================================================
// ROUTES
// ======================================================

// Root
app.get("/", (_req, res) => {
  res.json({ ok: true, service: "ENAVIA_BROWSER_EXECUTOR", mode: "private" });
});

// Health
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    pid: process.pid,
    uptime: process.uptime(),
    vnc: status(),
  });
});

// ================================
// ADMIN VNC
// ================================
app.post("/_admin/vnc/start", (req, res) => {
  if (!requireAdmin(req, res)) return;

  if (status().running) {
    res.json(Object.assign({ ok: true, already_running: true }, status()));
    return;
  }

  try {
    console.log("[ADMIN] start VNC solicitado");
    startVncStack();
    res.json(Object.assign({ ok: true, started: true }, status()));
  } catch (e) {
    console.error("[ADMIN] erro ao iniciar VNC:", e);
    stopVncStack();
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.post("/_admin/vnc/stop", (req, res) => {
  if (!requireAdmin(req, res)) return;
  stopVncStack();
  res.json(Object.assign({ ok: true, stopped: true }, status()));
});

// KEEPALIVE
setInterval(() => {
  console.log("[KEEPALIVE]", status());
}, 15000);

// ======================================================
// ✅ WS PROXY (noVNC → websockify interno)
// ======================================================
//
// O navegador vai abrir: wss://HOST/novnc/websockify (porta 443)
// Fly termina TLS e entrega pra nós como Upgrade HTTP.
// Aqui nós fazemos um "TCP tunnel" do Upgrade para 127.0.0.1:6080.
//
function proxyWebSocketToWebsockify(req, clientSocket, head) {
  const targetPort = VNC_WS_PORT; // 6080 (interno)
  const targetHost = "127.0.0.1";

  // ✅ MUDANÇA MÍNIMA (mas crucial):
  // - Não repassar "todos" os headers do cliente (isso pode quebrar o websockify).
  // - Construir um handshake WS mínimo e válido para o upstream.
  // - Logar a primeira linha da resposta do upstream (pra evidência no fly logs).
  const upstreamPath = "/";

  // Ajuda a evitar latência/fragmentação
  try {
    clientSocket.setNoDelay(true);
  } catch (_) {}

  const upstream = net.connect(targetPort, targetHost, () => {
    try {
      upstream.setNoDelay(true);
    } catch (_) {}

    const h = req.headers || {};

    // Headers mínimos/seguros para WebSocket handshake
    const pick = (name) => {
      const v = h[name];
      if (Array.isArray(v)) return v.join(", ");
      if (typeof v === "string") return v;
      return undefined;
    };

    const secKey = pick("sec-websocket-key");
    const secVer = pick("sec-websocket-version") || "13";
    const secProto = pick("sec-websocket-protocol");
    const secExt = pick("sec-websocket-extensions");
    const origin = pick("origin");
    const ua = pick("user-agent");
    const cookie = pick("cookie");

    // Linha inicial + headers essenciais
    const lines = [];
    lines.push(`GET ${upstreamPath} HTTP/${req.httpVersion || "1.1"}`);
    lines.push(`Host: ${targetHost}:${targetPort}`);
    lines.push("Upgrade: websocket");
    lines.push("Connection: Upgrade");

    if (secKey) lines.push(`Sec-WebSocket-Key: ${secKey}`);
    lines.push(`Sec-WebSocket-Version: ${secVer}`);

    if (secProto) lines.push(`Sec-WebSocket-Protocol: ${secProto}`);
    if (secExt) lines.push(`Sec-WebSocket-Extensions: ${secExt}`);
    if (origin) lines.push(`Origin: ${origin}`);
    if (ua) lines.push(`User-Agent: ${ua}`);
    if (cookie) lines.push(`Cookie: ${cookie}`);

    lines.push("", "");

    upstream.write(lines.join("\r\n"));

    if (head && head.length) upstream.write(head);

    // A partir daqui é túnel TCP bidirecional
    clientSocket.pipe(upstream);
    upstream.pipe(clientSocket);
  });

  // Logar primeira linha do upstream (evidência do que o websockify respondeu)
  let firstLineLogged = false;
  upstream.on("data", (chunk) => {
    if (firstLineLogged) return;
    firstLineLogged = true;
    try {
      const s = chunk.toString("utf8", 0, Math.min(chunk.length, 256));
      const line = s.split("\r\n")[0];
      console.log("[WS_PROXY] upstream first line:", line);
    } catch (e) {
      console.log("[WS_PROXY] upstream first line: <parse-failed>");
    }
  });

  upstream.on("error", (err) => {
    console.error(
      "[WS_PROXY] upstream error:",
      err && err.message ? err.message : err
    );
    try {
      clientSocket.destroy();
    } catch (_) {}
  });

  upstream.on("close", () => {
    try {
      clientSocket.destroy();
    } catch (_) {}
  });

  clientSocket.on("error", (err) => {
    console.error(
      "[WS_PROXY] client socket error:",
      err && err.message ? err.message : err
    );
    try {
      upstream.destroy();
    } catch (_) {}
  });

  clientSocket.on("close", () => {
    try {
      upstream.destroy();
    } catch (_) {}
  });
}

// ======================================================
// AUTO-START VNC (CANÔNICO PARA FLY)
// ======================================================
try {
  console.log("[BOOT] auto-start VNC");
  startVncStack();
} catch (e) {
  console.error("[BOOT] falha ao iniciar VNC:", e);
}

// ======================================================
// LISTEN (HTTP server + upgrade handler)
// ======================================================
const PORT = process.env.PORT || "8080";
console.log("[BOOT] Tentando listen em PORT:", PORT);

const server = http.createServer(app);

server.on("upgrade", (req, socket, head) => {
  try {
    const u = new URL(req.url, "http://localhost");
    const pathname = u.pathname;

    // ✅ Proxy do WS do noVNC
    if (pathname === "/novnc/websockify") {
      return proxyWebSocketToWebsockify(req, socket, head);
    }

    socket.destroy();
  } catch (e) {
    console.error("[WS_PROXY] upgrade handler error:", e);
    try {
      socket.destroy();
    } catch (_) {}
  }
});

server.listen(Number(PORT), "0.0.0.0", () => {
  console.log("[LISTEN] API online em", PORT);
});

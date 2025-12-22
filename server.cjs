const express = require("express");
const bodyParser = require("body-parser");
const { spawn } = require("child_process");
const path = require("path");
const http = require("http");
const net = require("net");
const { URL } = require("url");

console.log("[BOOT] Processo iniciando…");
console.log("[BOOT] NODE_ENV:", process.env.NODE_ENV);
console.log("[BOOT] PORT env:", process.env.PORT);
console.log("[BOOT] PID:", process.pid);

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));

const app = express();
app.use(bodyParser.json({ limit: "10mb" }));

// ======================================================
// noVNC PATH
// ======================================================
const NOVNC_PATH = path.resolve(process.cwd(), "public/novnc");

// ======================================================
// ✅ REDIRECT CANÔNICO DO noVNC (ANTES DO STATIC)
// ======================================================
app.get(["/novnc", "/novnc/"], (req, res) => {
  const host = req.hostname;
  const proto = req.headers["x-forwarded-proto"] || "https";
  const publicPort = proto === "http" ? 80 : 443;

  const qs =
    `host=${encodeURIComponent(host)}` +
    `&port=${encodeURIComponent(String(publicPort))}` +
    `&path=${encodeURIComponent("novnc/websockify")}` +
    `&autoconnect=1`;

  res.redirect(`/novnc/vnc.html?${qs}`);
});

// ======================================================
// STATIC FILES (noVNC) — DEPOIS DO REDIRECT
// ======================================================
app.use("/novnc", express.static(NOVNC_PATH));

// ======================================================
// CONFIG VNC
// ======================================================
const ADMIN_TOKEN = process.env.ENAVIA_VNC_ADMIN_TOKEN || "";
const VNC_PASSWORD = process.env.VNC_PASSWORD || "";
const VNC_DISPLAY = process.env.VNC_DISPLAY || ":99";
const VNC_PORT = Number(process.env.VNC_PORT || 5900);
const VNC_WS_PORT = Number(process.env.VNC_WS_PORT || 6080);

let xvfbProc = null;
let x11vncProc = null;
let websockifyProc = null;

function isRunning(p) {
  return p && p.pid && !p.killed;
}

function status() {
  return {
    running:
      isRunning(xvfbProc) &&
      isRunning(x11vncProc) &&
      isRunning(websockifyProc),
  };
}

function startVncStack() {
  if (!VNC_PASSWORD) throw new Error("VNC_PASSWORD não definido");

  xvfbProc = spawn("Xvfb", [VNC_DISPLAY, "-screen", "0", "1280x720x24"]);
  x11vncProc = spawn("x11vnc", [
    "-display",
    VNC_DISPLAY,
    "-rfbport",
    String(VNC_PORT),
    "-passwd",
    VNC_PASSWORD,
    "-forever",
  ]);
  websockifyProc = spawn("websockify", [
    String(VNC_WS_PORT),
    "127.0.0.1:" + VNC_PORT,
  ]);
}

// ======================================================
// ADMIN
// ======================================================
function requireAdmin(req, res) {
  if (req.headers["x-enavia-token"] !== ADMIN_TOKEN) {
    res.status(401).json({ ok: false });
    return false;
  }
  return true;
}

app.post("/_admin/vnc/start", (req, res) => {
  if (!requireAdmin(req, res)) return;
  startVncStack();
  res.json({ ok: true, started: true });
});

// ======================================================
// ROOT / HEALTH
// ======================================================
app.get("/", (_, res) =>
  res.json({ ok: true, service: "ENAVIA_BROWSER_EXECUTOR" })
);

app.get("/health", (_, res) =>
  res.json({ ok: true, vnc: status() })
);

// ======================================================
// WS PROXY
// ======================================================
function proxyWebSocket(req, clientSocket, head) {
  const upstream = net.connect(VNC_WS_PORT, "127.0.0.1", () => {
    clientSocket.pipe(upstream);
    upstream.pipe(clientSocket);
  });
}

const server = http.createServer(app);

server.on("upgrade", (req, socket, head) => {
  const u = new URL(req.url, "http://localhost");
  if (u.pathname === "/novnc/websockify") {
    return proxyWebSocket(req, socket, head);
  }
  socket.destroy();
});

// ======================================================
server.listen(process.env.PORT || 8080, "0.0.0.0", () =>
  console.log("[LISTEN] API online")
);

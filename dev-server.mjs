// Serveur de dev du client Web mindlog · talk — statique + proxy API.
//
// Reproduit, sans dépendance, la couche de service que le backend Hono assurait
// jusqu'ici (avant la scission client/backend) :
//   - `/static/*`            → fichiers de `web/` (préfixe retiré)
//   - `/api|/mcp|/oauth|…`   → proxifiés vers le backend (défaut localhost:8787)
//   - manifest / sw / assets → servis depuis `web/`
//   - toute autre navigation → `web/index.html` (routeur SPA côté client)
//
// En prod, ce rôle est tenu par l'edge (Caddy, une seule origine) — cf. T40.

import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("./web", import.meta.url));
const BACKEND = new URL(process.env.BACKEND_URL || "http://localhost:8787");
const PORT = Number(process.env.PORT || 3000);

// Préfixes servis par le backend (jamais par le client).
const proxied = (p) =>
  p === "/mcp" || p.startsWith("/api/") || p.startsWith("/mcp/") ||
  p.startsWith("/oauth/") || p.startsWith("/.well-known/") ||
  p === "/me/broadcast" || p.startsWith("/internal/") || p.startsWith("/admin");

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
  ".webp": "image/webp", ".jpg": "image/jpeg", ".webmanifest": "application/manifest+json",
  ".pdf": "application/pdf", ".mp3": "audio/mpeg", ".wasm": "application/wasm",
  ".woff2": "font/woff2", ".woff": "font/woff", ".ico": "image/x-icon",
};

function proxy(req, res) {
  const opts = {
    hostname: BACKEND.hostname, port: BACKEND.port, path: req.url,
    method: req.method, headers: { ...req.headers, host: BACKEND.host },
  };
  const up = http.request(opts, (pr) => {
    res.writeHead(pr.statusCode || 502, pr.headers);
    pr.pipe(res);
  });
  up.on("error", () => { res.writeHead(502, { "content-type": "text/plain" }); res.end("backend indisponible"); });
  req.pipe(up);
}

async function sendFile(res, filePath) {
  try {
    const data = await readFile(filePath);
    res.writeHead(200, { "content-type": MIME[extname(filePath)] || "application/octet-stream" });
    res.end(data);
    return true;
  } catch { return false; }
}

const server = http.createServer(async (req, res) => {
  let path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (proxied(path)) return proxy(req, res);

  if (path.startsWith("/static/")) path = path.slice("/static".length);
  const rel = normalize(path).replace(/^(\.\.[/\\])+/, ""); // anti path-traversal
  const filePath = join(ROOT, rel);

  if (path !== "/" && await stat(filePath).then((s) => s.isFile()).catch(() => false)) {
    if (await sendFile(res, filePath)) return;
  }
  // Repli SPA : le routeur JS distingue landing / profil / éditeur d'après l'URL.
  await sendFile(res, join(ROOT, "index.html"));
});

server.listen(PORT, () => {
  console.log(`client dev → http://localhost:${PORT}  (API proxifiée vers ${BACKEND.origin})`);
});

// AniTrack — local server: serves the site, handles MyAnimeList OAuth (PKCE),
// and proxies MAL API calls (MAL's API doesn't allow browser CORS).
// No dependencies. Node 18+.  Run:  node server.js
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

loadEnv(path.join(__dirname, ".env"));
const PORT = Number(process.env.PORT || 3000);
const CLIENT_ID = process.env.MAL_CLIENT_ID || "";
const CLIENT_SECRET = process.env.MAL_CLIENT_SECRET || "";
const REDIRECT_URI = `http://localhost:${PORT}/auth/callback`;
const TOKEN_FILE = path.join(__dirname, "tokens.json");
const PUBLIC = path.join(__dirname, "public");

let tokens = readJSON(TOKEN_FILE);
const pending = new Map(); // state -> code_verifier

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/manifest+json", ".json": "application/json" };

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (url.pathname === "/auth/status") return json(res, 200, { configured: !!CLIENT_ID, loggedIn: !!tokens?.access_token });
    if (url.pathname === "/auth/login") return login(res);
    if (url.pathname === "/auth/callback") return await callback(url, res);
    if (url.pathname === "/auth/logout") { tokens = null; fs.rmSync(TOKEN_FILE, { force: true }); return json(res, 200, { ok: true }); }
    if (url.pathname.startsWith("/api/mal/")) return await proxy(req, url, res);
    return serveStatic(url.pathname, res);
  } catch (e) {
    console.error(e);
    json(res, 500, { error: String(e.message || e) });
  }
}).listen(PORT, () => {
  console.log(`AniTrack running at http://localhost:${PORT}`);
  if (!CLIENT_ID) console.log("⚠  MAL_CLIENT_ID not set — browsing works, list tracking disabled. See README.md.");
});

function login(res) {
  if (!CLIENT_ID) return json(res, 400, { error: "MAL_CLIENT_ID not configured" });
  // MAL only supports the "plain" PKCE method: challenge == verifier.
  const verifier = crypto.randomBytes(64).toString("base64url").slice(0, 128);
  const state = crypto.randomBytes(16).toString("hex");
  pending.set(state, verifier);
  const q = new URLSearchParams({ response_type: "code", client_id: CLIENT_ID, code_challenge: verifier, code_challenge_method: "plain", state, redirect_uri: REDIRECT_URI });
  res.writeHead(302, { Location: `https://myanimelist.net/v1/oauth2/authorize?${q}` }).end();
}

async function callback(url, res) {
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  const verifier = pending.get(state);
  if (!code || !verifier) return json(res, 400, { error: "Invalid OAuth callback (state mismatch or missing code)" });
  pending.delete(state);
  await tokenRequest({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: REDIRECT_URI });
  res.writeHead(302, { Location: "/#mylist" }).end();
}

async function tokenRequest(params) {
  const body = new URLSearchParams({ client_id: CLIENT_ID, ...params });
  if (CLIENT_SECRET) body.set("client_secret", CLIENT_SECRET);
  const r = await fetch("https://myanimelist.net/v1/oauth2/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  const data = await r.json();
  if (!r.ok) throw new Error(`MAL token error: ${data.error || r.status} ${data.message || ""}`);
  tokens = data;
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2), { mode: 0o600 });
}

async function proxy(req, url, res) {
  if (!tokens?.access_token) return json(res, 401, { error: "Not connected to MyAnimeList" });
  const target = `https://api.myanimelist.net/v2/${url.pathname.slice("/api/mal/".length)}${url.search}`;
  const body = ["GET", "HEAD"].includes(req.method) ? undefined : await readBody(req);
  const send = () => fetch(target, {
    method: req.method,
    headers: { Authorization: `Bearer ${tokens.access_token}`, ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
    body,
  });
  let r = await send();
  if (r.status === 401 && tokens.refresh_token) {
    await tokenRequest({ grant_type: "refresh_token", refresh_token: tokens.refresh_token });
    r = await send();
  }
  res.writeHead(r.status, { "Content-Type": r.headers.get("content-type") || "application/json" });
  res.end(Buffer.from(await r.arrayBuffer()));
}

function serveStatic(p, res) {
  const file = path.normalize(path.join(PUBLIC, p === "/" ? "index.html" : p));
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return json(res, 404, { error: "Not found" });
  res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" });
  fs.createReadStream(file).pipe(res);
}

function json(res, status, obj) { res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(obj)); }
function readBody(req) { return new Promise((ok, fail) => { let d = ""; req.on("data", c => (d += c)); req.on("end", () => ok(d)); req.on("error", fail); }); }
function readJSON(f) { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } }
function loadEnv(f) {
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

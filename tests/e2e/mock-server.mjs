// SEMAPHORE LOCAL MOCK: a Node stand-in for the Windows PowerShell server (server/Http.ps1 and
// server/Routes.ps1) for the end-to-end suite and for UI work off Windows. It serves web/dist and the
// API the UI uses, with the same gate, the same launch-code exchange and the same presence rules.
// It never runs a query against a real database and never calls Fairlead.
//
//   node tests/e2e/mock-server.mjs [--port 0] [--home <dir>] [--web <dir>] [--stay] [--view ask] [--vault <state>]
//
//   --port      0 (default) picks a free loopback port
//   --home      the Semaphore folder (hoists, catalogs, playbook, snapshots, questions, team);
//               default: a new temp folder, removed when the mock stops unless --keep-home
//   --stay      keep running when the last tab is gone (as Launch-Semaphore.bat --stay)
//   --vault     what a paired Lazarette looks like: "unlocked" (default), "locked" (423 vault-locked
//               state in /api/vault) or "down" (Lazarette not running). Pairing itself is in memory.
//
// The page's Content-Security-Policy and the other security headers are READ FROM server/Http.ps1
// ($script:SemCsp, $script:SemPermissionsPolicy, Get-SemSecurityHeaders): the mock refuses to start
// when it cannot find them, so it can never drift to a looser policy than the real server sends.
//
// Like Start-Semaphore.ps1 --no-browser it prints
//   Semaphore <version> is running at http://127.0.0.1:<port>/. ...
//   Session link (works once, for 10 minutes): http://127.0.0.1:<port>/?launch=<code>
// plus "Home: <dir>". Presence timing for tests (milliseconds, environment):
//   SEMAPHORE_MOCK_HEARTBEAT_TIMEOUT_MS (90000), SEMAPHORE_MOCK_LEAVING_GRACE_MS (5000),
//   SEMAPHORE_MOCK_FIRST_HEARTBEAT_MS (120000), SEMAPHORE_MOCK_CHECK_MS (1000)
//
// Test-only hooks (not part of Semaphore's API; same Host/Origin gate, no token):
//   POST /__mock/launch  -> { code, link }      mint a launch code, as a second launcher run would
//   GET  /__mock/state   -> { home, port, autoStop, tabs: [...], clientLog: [...], saves: n, vault }
//   POST /__mock/reset   -> { ok: true }        back to a fresh start: every stored document and the
//                                               .trash folders gone, unpaired, the client-log rate
//                                               limiter, client log and save counter cleared, the
//                                               vault state back to the --vault default. Presence is
//                                               kept (the calling page's tab is still open).
//   POST /__mock/vault { state }                "unlocked" | "locked" | "down" for the next answers

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');

// ---------------------------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------------------------
const argv = process.argv.slice(2);
function opt(name, dflt) {
  const i = argv.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return dflt;
  const a = argv[i];
  if (a.includes('=')) return a.slice(a.indexOf('=') + 1);
  return argv[i + 1] ?? dflt;
}
const has = (name) => argv.includes(`--${name}`);
const msEnv = (name, dflt) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : dflt;
};

const requestedPort = Number(opt('port', '0'));
const webRoot = path.resolve(opt('web', path.join(repo, 'web', 'dist')));
const keepHome = has('keep-home') || opt('home', '') !== '';
const homeDir = path.resolve(opt('home', '') || mkdtempSync(path.join(tmpdir(), 'semaphore-mock-')));
const stay = has('stay') || process.env.SEMAPHORE_AUTO_STOP === '0';
const view = opt('view', '');
const VAULT_STATES = ['unlocked', 'locked', 'down'];
const vaultDefault = opt('vault', 'unlocked');
if (!VAULT_STATES.includes(vaultDefault)) {
  console.error(`mock: --vault must be one of ${VAULT_STATES.join(', ')}, not "${vaultDefault}".`);
  process.exit(2);
}
const version = (() => {
  try {
    return readFileSync(path.join(repo, 'VERSION'), 'utf8').trim();
  } catch {
    return '0.0.0';
  }
})();

// The CSP and the fixed security headers are read from server/Http.ps1 (Get-SemSecurityHeaders), so
// the mock never drifts from the real server. No fallback: a miss stops the mock with a message.
const { CSP, FIXED_HEADERS, SANDBOX } = (() => {
  const file = path.join(repo, 'server', 'Http.ps1');
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    console.error(`mock: cannot read ${file}: ${e.message}`);
    process.exit(2);
  }
  const fail = (what) => {
    console.error(`mock: ${what} in server/Http.ps1; the mock's headers come from there, so update this reader to match.`);
    process.exit(2);
  };
  const csp = /^\$script:SemCsp\s*=\s*"([^"\r\n]+)"\s*$/m.exec(text)?.[1];
  if (!csp || !/^default-src 'self'; script-src 'self';/.test(csp)) fail('could not find $script:SemCsp = "default-src ..."');
  const permissions = /^\$script:SemPermissionsPolicy\s*=\s*'([^'\r\n]+)'\s*$/m.exec(text)?.[1];
  if (!permissions) fail("could not find $script:SemPermissionsPolicy = '...'");
  // The literal 'Name: value' lines of Get-SemSecurityHeaders, in the order the server sends them.
  const fnStart = text.indexOf('function Get-SemSecurityHeaders');
  const fnEnd = fnStart < 0 ? -1 : text.indexOf('\nfunction ', fnStart + 1);
  const fn = fnStart < 0 ? '' : text.slice(fnStart, fnEnd < 0 ? undefined : fnEnd);
  const fixed = [...fn.matchAll(/^\s*'([A-Za-z-]+): ([^'\r\n]+)',?\s*$/gm)].map((m) => [m[1], m[2]]);
  if (!fixed.some(([n]) => n === 'X-Content-Type-Options') || !fixed.some(([n]) => n === 'Cross-Origin-Opener-Policy')) fail('could not read the header list of Get-SemSecurityHeaders');
  // The custom widget frame's headers (/sandbox/): its own CSP, and framing and loading allowed from its opaque origin.
  const sandboxCsp = /^\$script:SemSandboxCsp\s*=\s*"([^"\r\n]+)"\s*$/m.exec(text)?.[1];
  const frameOptions = /^\$script:SemSandboxFrameOptions\s*=\s*'([^'\r\n]+)'\s*$/m.exec(text)?.[1];
  const resourcePolicy = /^\$script:SemSandboxResourcePolicy\s*=\s*'([^'\r\n]+)'\s*$/m.exec(text)?.[1];
  if (!sandboxCsp || !/default-src 'none'/.test(sandboxCsp) || !frameOptions || !resourcePolicy) fail('could not find $script:SemSandboxCsp, $script:SemSandboxFrameOptions and $script:SemSandboxResourcePolicy');
  return { CSP: csp, FIXED_HEADERS: [...fixed, ['Permissions-Policy', permissions]], SANDBOX: { csp: sandboxCsp, frameOptions, resourcePolicy } };
})();

const MAX_BODY = 8388608; // 8 MB, Http.ps1 $script:SemMaxBody
const DOC_MAX = 2097152; // 2 MB, Routes.ps1 $script:SemDocMaxBytes
const LAUNCH_TTL_MS = 600_000;
const CLIENT_LOG_MAX = 4096;
const CLIENT_LOG_PER_MIN = 20;
const KINDS = ['hoists', 'catalogs', 'playbook', 'snapshots', 'questions', 'team'];
const WIDGET_CODE_MAX = 65536; // Routes.ps1 $script:SemWidgetCodeMax
const WIDGET_CSS_MAX = 16384;
const WIDGET_MAX_COUNT = 500;
const NOUN = { hoists: 'hoist', catalogs: 'catalog', playbook: 'playbook entry', snapshots: 'snapshot', questions: 'question', team: 'team note' };
const HASHED_ASSET = /[.-][A-Za-z0-9]{8,}\.[a-z0-9]+$/; // contract 4

const token = randomBytes(32).toString('base64url');
const launchCodes = new Map(); // code -> expiry (ms)
let vaultPaired = false;
let vaultState = vaultDefault;
// Get-SemVaultStatus (server/Vault.ps1): paired from the pairing file; running, locked and problem
// from one request to Lazarette. The sentences are the server's.
const NOT_PAIRED = 'Semaphore is not paired with Lazarette. In Lazarette open Settings > Tools, pair a tool named Semaphore, then paste the code in Semaphore under Settings > Lazarette (or run Semaphore-CLI.bat vault pair).';
function vaultStatus() {
  const out = { tool: 'Semaphore', paired: vaultPaired, running: vaultState !== 'down', locked: null, problem: vaultPaired ? null : NOT_PAIRED, sources: [], shared: [], notShared: [] };
  if (!out.running) out.problem = 'Lazarette is not running on this computer. Start it and unlock it.' + (vaultPaired ? '' : ' ' + NOT_PAIRED);
  else if (vaultPaired) out.locked = vaultState === 'locked';
  if (vaultPaired && out.locked) out.problem = 'Lazarette is locked. Unlock Lazarette in its window and try again.';
  return out;
}
const presence = {
  autoStop: !stay,
  timeoutMs: msEnv('SEMAPHORE_MOCK_HEARTBEAT_TIMEOUT_MS', 90_000),
  graceMs: msEnv('SEMAPHORE_MOCK_LEAVING_GRACE_MS', 5_000),
  firstMs: msEnv('SEMAPHORE_MOCK_FIRST_HEARTBEAT_MS', 120_000),
  tabs: new Map(), // tab -> { seen, leaving }
  everSeen: false,
  started: Date.now(),
};
const clientLog = [];
const clientLogTimes = [];
let saves = 0;
let port = 0;
let stopping = false;

for (const k of [...KINDS, 'widgets']) mkdirSync(path.join(homeDir, k), { recursive: true });
const logFile = path.join(homeDir, 'semaphore-mock.log');
function log(level, text) {
  const line = `${new Date().toISOString()} [${level}] ${text}`;
  try {
    appendFileSync(logFile, line + '\n');
  } catch {
    /* the log is best effort */
  }
  if (level !== 'DEBUG') console.log(line);
}

// ---------------------------------------------------------------------------------------------
// Responses (Get-SemSecurityHeaders, Send-SemBytes)
// ---------------------------------------------------------------------------------------------
function securityHeaders(cache, sandbox = false) {
  const h = { 'Content-Security-Policy': CSP, ...Object.fromEntries(FIXED_HEADERS), 'Cache-Control': cache };
  if (sandbox) Object.assign(h, { 'Content-Security-Policy': SANDBOX.csp, 'X-Frame-Options': SANDBOX.frameOptions, 'Cross-Origin-Resource-Policy': SANDBOX.resourcePolicy });
  return h;
}
function send(res, status, type, body, { cache = 'no-store', headers = {}, head = false, sandbox = false } = {}) {
  const bytes = body === undefined || body === null ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
  const h = { ...(type ? { 'Content-Type': type } : {}), 'Content-Length': String(bytes.length), Connection: 'close', ...securityHeaders(cache, sandbox), ...headers };
  res.writeHead(status, h);
  res.end(head ? undefined : bytes);
}
const sendJson = (res, status, obj, headers = {}) => send(res, status, 'application/json; charset=utf-8', JSON.stringify(obj), { headers });
const sendJsonText = (res, status, text, headers = {}) => send(res, status, 'application/json; charset=utf-8', text, { headers });
const sendError = (res, status, code, message, extra = {}) => sendJson(res, status, { error: message, code, ...extra });

// ---------------------------------------------------------------------------------------------
// Gate (Test-SemRequestOrigin, Test-SemStringsEqual)
// ---------------------------------------------------------------------------------------------
function sameString(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}
function originOk(req) {
  const remote = req.socket.remoteAddress ?? '';
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) return false;
  const host = String(req.headers.host ?? '').toLowerCase();
  if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(host)) return false;
  if (req.headers.origin !== undefined) {
    const o = String(req.headers.origin).toLowerCase();
    if (![`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(o)) return false;
  }
  return true;
}

function newLaunchCode() {
  const code = randomBytes(32).toString('base64url');
  launchCodes.set(code, Date.now() + LAUNCH_TTL_MS);
  return code;
}
function useLaunchCode(candidate) {
  const now = Date.now();
  let hit = null;
  for (const [k, exp] of launchCodes) {
    if (exp <= now) {
      launchCodes.delete(k);
      continue;
    }
    if (sameString(candidate, k)) hit = k;
  }
  if (!hit) return false;
  launchCodes.delete(hit);
  return true;
}
function sessionLink() {
  return `http://127.0.0.1:${port}/?launch=${newLaunchCode()}${view === 'ask' || view === 'refresh' ? `&view=${view}` : ''}`;
}

// ---------------------------------------------------------------------------------------------
// Presence (Register-SemPresence, Test-SemShouldAutoStop)
// ---------------------------------------------------------------------------------------------
function registerPresence(tab, leaving, now = Date.now()) {
  if (!presence.tabs.has(tab)) {
    for (const [k, t] of presence.tabs) if (now - t.seen > 600_000) presence.tabs.delete(k);
    if (presence.tabs.size >= 64) return;
    if (leaving) return; // a leaving signal from a tab never seen changes nothing
    presence.tabs.set(tab, { seen: now, leaving: null });
  }
  const t = presence.tabs.get(tab);
  if (leaving) t.leaving = now;
  else {
    t.seen = now;
    t.leaving = null;
    presence.everSeen = true;
  }
}
function shouldAutoStop(now = Date.now()) {
  if (!presence.autoStop) return false;
  if (!presence.everSeen) return now - presence.started >= presence.firstMs;
  for (const t of presence.tabs.values()) {
    if (t.leaving !== null) {
      if (now - t.leaving >= presence.graceMs) continue;
      if (now - t.seen < presence.timeoutMs) return false;
      continue;
    }
    if (now - t.seen < presence.timeoutMs) return false;
  }
  return true;
}
function liveTabs(now = Date.now()) {
  let n = 0;
  for (const t of presence.tabs.values()) if (t.leaving === null && now - t.seen < presence.timeoutMs) n++;
  return n;
}

// ---------------------------------------------------------------------------------------------
// Static files (Resolve-SemStaticFile, Send-SemStatic)
// ---------------------------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
  '.wasm': 'application/wasm', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json',
};
function resolveStatic(urlPath) {
  if (urlPath.includes('//')) return { kind: 'refused' };
  const rel = urlPath.replace(/^\/+/, '');
  if (rel.includes('\\') || rel.includes(':')) return { kind: 'refused' };
  for (const seg of rel.split('/')) if (seg.startsWith('.')) return { kind: 'refused' };
  const rootFull = path.resolve(webRoot) + path.sep;
  const index = rootFull + 'index.html';
  if (rel !== '' && rel !== 'index.html') {
    const full = path.resolve(rootFull + rel);
    if (!full.startsWith(rootFull)) return { kind: 'refused' };
    if (existsSync(full) && statSync(full).isFile()) return { kind: 'file', file: full };
    const last = rel.replace(/\/+$/, '').split('/').pop() ?? '';
    if (last.includes('.')) return { kind: 'missing' };
  }
  if (existsSync(index)) return { kind: 'index', file: index };
  return { kind: 'notbuilt' };
}
function serveStatic(req, res, urlPath) {
  const head = req.method === 'HEAD';
  const r = resolveStatic(urlPath);
  // /sandbox/ holds the custom widget frame: its own headers, and no app-route fallback.
  const sandbox = urlPath.startsWith('/sandbox/');
  if (r.kind === 'refused' || r.kind === 'missing' || (sandbox && r.kind !== 'file')) return sendError(res, 404, 'not-found', 'Not found.');
  if (r.kind === 'notbuilt') {
    return send(res, 200, 'text/html; charset=utf-8', `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Semaphore</title></head><body><h1>Semaphore ${version}</h1><p>This copy of Semaphore has no browser interface: web\\dist\\index.html is missing. The browser interface has not been built.</p></body></html>`, { head });
  }
  const isHtml = r.file.toLowerCase().endsWith('.html');
  const rel = path.relative(webRoot, r.file).split(path.sep).join('/');
  const cache = isHtml ? 'no-store' : (rel.startsWith('assets/') || rel.startsWith('sandbox/')) && HASHED_ASSET.test(rel) ? 'public, max-age=31536000, immutable' : 'no-cache';
  send(res, 200, MIME[path.extname(r.file).toLowerCase()] ?? 'application/octet-stream', readFileSync(r.file), { cache, head, sandbox });
}

// ---------------------------------------------------------------------------------------------
// Document store (Get-SemDocList, Read-SemDoc, Test-SemDocBody, Save-SemDoc, Remove-SemDoc)
// ---------------------------------------------------------------------------------------------
const validId = (id) => /^[A-Za-z0-9_-]{1,64}$/.test(id);
const etagOf = (bytes) => `"${createHash('sha256').update(bytes).digest('hex')}"`;
const stripBom = (t) => t.replace(/^﻿/, '');
function docDir(kind) {
  const d = path.join(homeDir, kind);
  mkdirSync(d, { recursive: true });
  return d;
}
function readJsonObject(file) {
  try {
    if (statSync(file).size > DOC_MAX) return null;
    const text = stripBom(readFileSync(file, 'utf8'));
    if (!text.trimStart().startsWith('{')) return null;
    const j = JSON.parse(text);
    return j && typeof j === 'object' && !Array.isArray(j) ? { j, text } : null;
  } catch {
    return null;
  }
}
function docFiles(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.json') && validId(e.name.slice(0, -5)))
    .map((e) => e.name)
    .sort();
}
function docList(dir) {
  const out = [];
  for (const name of docFiles(dir)) {
    const file = path.join(dir, name);
    const doc = readJsonObject(file);
    if (!doc) continue;
    const id = name.slice(0, -5);
    let title = id;
    for (const k of ['title', 'label', 'name']) {
      const v = doc.j[k];
      if (typeof v === 'string' && v.trim() !== '') {
        title = v.trim();
        break;
      }
    }
    const updated = typeof doc.j.updated === 'string' && doc.j.updated ? doc.j.updated : statSync(file).mtime.toISOString();
    out.push({ id, title, updated });
  }
  return out;
}
function docFullList(dir) {
  const parts = [];
  for (const name of docFiles(dir)) {
    if (parts.length >= 2000) break;
    const doc = readJsonObject(path.join(dir, name));
    if (doc) parts.push(doc.text);
  }
  return `[${parts.join(',')}]`;
}
function checkDocBody(bytes) {
  if (!bytes.length) return 'The body is empty.';
  if (bytes.length > DOC_MAX) return 'too-large';
  const text = stripBom(bytes.toString('utf8'));
  if (!text.trimStart().startsWith('{')) return 'The body must be a JSON object.';
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    return 'The body is not valid JSON.';
  }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return 'The body must be a JSON object.';
  if (j.version !== 1) return 'The document must have "version": 1.';
  return null;
}
function saveDoc(dir, id, bytes) {
  // Atomic: a temp file in the same folder, then a rename over the old one.
  const file = path.join(dir, `${id}.json`);
  const tmp = path.join(dir, `.${id}.${randomBytes(8).toString('hex')}.tmp`);
  writeFileSync(tmp, bytes);
  try {
    renameSync(tmp, file);
  } finally {
    if (existsSync(tmp)) rmSync(tmp, { force: true });
  }
}
function removeDoc(dir, id) {
  const file = path.join(dir, `${id}.json`);
  if (!existsSync(file)) return false;
  const trash = path.join(dir, '.trash');
  mkdirSync(trash, { recursive: true });
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  let dest = path.join(trash, `${id}-${stamp}.json`);
  for (let n = 2; existsSync(dest); n++) dest = path.join(trash, `${id}-${stamp}-${n}.json`);
  renameSync(file, dest);
  return true;
}
function docRoute(req, res, kind, id, query, body) {
  const dir = docDir(kind);
  const noun = NOUN[kind];
  if (id === null) {
    if (req.method !== 'GET') return sendError(res, 405, 'method', 'Method not allowed.');
    if ((kind === 'playbook' || kind === 'questions' || kind === 'team') && /(^|&)full=1(&|$)/.test(query)) return sendJsonText(res, 200, docFullList(dir));
    return sendJson(res, 200, docList(dir));
  }
  if (!validId(id)) return sendError(res, 400, 'bad-id', `Invalid ${noun} id: use 1 to 64 letters, digits, _ or -.`);
  const file = path.join(dir, `${id}.json`);
  switch (req.method) {
    case 'GET': {
      if (!existsSync(file)) return sendError(res, 404, 'not-found', `No ${noun} '${id}'.`);
      const bytes = readFileSync(file);
      return send(res, 200, 'application/json; charset=utf-8', bytes, { headers: { ETag: etagOf(bytes) } });
    }
    case 'PUT': {
      const problem = checkDocBody(body);
      if (problem === 'too-large') return sendError(res, 413, 'too-large', `A ${noun} may be at most 2 MB.`);
      if (problem) return sendError(res, 400, 'invalid', problem);
      const ifMatch = req.headers['if-match'];
      if (ifMatch !== undefined && existsSync(file)) {
        const current = etagOf(readFileSync(file));
        if (String(ifMatch).trim() !== current) {
          log('WARN', `Refused to save ${noun} ${id}: it changed since this tab read it`);
          return sendError(res, 409, 'version', `This ${noun} was changed somewhere else since you opened it.`, { etag: current.slice(1, -1) });
        }
      }
      saveDoc(dir, id, body);
      saves++;
      log('INFO', `Saved ${noun} ${id} (${body.length} bytes)`);
      return sendJson(res, 200, { ok: true, etag: etagOf(body).slice(1, -1) });
    }
    case 'DELETE': {
      if (!removeDoc(dir, id)) return sendError(res, 404, 'not-found', `No ${noun} '${id}'.`);
      log('INFO', `Moved ${noun} ${id} to .trash`);
      return sendJson(res, 200, { ok: true });
    }
    default:
      return sendError(res, 405, 'method', 'Method not allowed.');
  }
}

// ---------------------------------------------------------------------------------------------
// API (Invoke-SemRequest, Invoke-SemRoute)
// ---------------------------------------------------------------------------------------------
function info() {
  // Get-SemInfo (server/Routes.ps1): `social` carries the deployment's feature switches from
  // config/settings.json (signalBook, impact, teamLog, showAskers, bz); all on here.
  return { tool: 'semaphore', version, pid: process.pid, port, home: homeDir, autoStop: presence.autoStop, stay, sources: [], user: process.env.USERNAME || process.env.USER || 'analyst', reviewer: '', view, skin: '', social: { signalBook: true, impact: true, teamLog: true, showAskers: true, bz: true } };
}
function aiStatus() {
  return {
    configured: false,
    provider: 'fairlead',
    url: 'http://127.0.0.1:8786',
    model: 'local',
    privacyLocal: true,
    keySource: 'none',
    problem: null,
    setup: 'Open Fairlead > Clients and install a key for Semaphore (or run Set-SemaphoreAiKey.bat as a fallback). Until then, local rules draft every flag.',
  };
}
const tabOk = (t) => typeof t === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(t);

function clientLogRoute(req, res, json, body) {
  // Contract 2 (#89): { level, message, stack?, view? }, at most 4 KB and 20 a minute; 204.
  if (req.method !== 'POST') return sendError(res, 405, 'method', 'Method not allowed.');
  if (body.length > CLIENT_LOG_MAX) return sendError(res, 413, 'too-large', 'A client log entry may be at most 4 KB.');
  if (!json || (json.level !== 'error' && json.level !== 'warn') || typeof json.message !== 'string') return sendError(res, 400, 'invalid', 'Send { level: "error" or "warn", message }.');
  const now = Date.now();
  while (clientLogTimes.length && now - clientLogTimes[0] > 60_000) clientLogTimes.shift();
  if (clientLogTimes.length >= CLIENT_LOG_PER_MIN) return sendError(res, 429, 'rate', 'Too many client log entries; try again in a minute.');
  clientLogTimes.push(now);
  const entry = { level: json.level, message: json.message.slice(0, 1000), ...(typeof json.stack === 'string' ? { stack: json.stack.slice(0, 2000) } : {}), ...(typeof json.view === 'string' ? { view: json.view.slice(0, 40) } : {}) };
  clientLog.push(entry);
  log(json.level === 'error' ? 'ERROR' : 'WARN', `Browser: ${entry.message}${entry.view ? ` (view ${entry.view})` : ''}`);
  send(res, 204, '', null);
}

// ---------------------------------------------------------------------------------------------
// Team widget library (Invoke-SemWidgetRoute): <home>/widgets/<id>.json
// ---------------------------------------------------------------------------------------------
const widgetText = (v, max) => (typeof v === 'string' ? [...v.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim()].slice(0, max).join('').trim() : '');
const widgetId = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/g, '') || 'widget';
function widgetRoute(req, res, id, json) {
  const dir = docDir('widgets');
  if (id === null) {
    if (req.method === 'GET') {
      const out = [];
      for (const name of docFiles(dir).slice(0, WIDGET_MAX_COUNT)) {
        const doc = readJsonObject(path.join(dir, name));
        if (!doc) continue;
        const wid = name.slice(0, -5);
        out.push({ id: wid, name: widgetText(doc.j.name, 80) || wid, description: widgetText(doc.j.description, 500), by: widgetText(doc.j.by, 64), updated: typeof doc.j.updated === 'string' ? doc.j.updated : '' });
      }
      out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      return sendJson(res, 200, out);
    }
    if (req.method !== 'POST') return sendError(res, 405, 'method', 'Method not allowed.');
    if (!json) return sendError(res, 400, 'bad-json', 'The body must be a JSON object.');
    const name = widgetText(json.name, 80);
    if (!name) return sendError(res, 400, 'invalid', 'Give the widget a name (letters, digits, spaces; at most 80 characters).');
    if (typeof json.code !== 'string' || json.code.trim() === '') return sendError(res, 400, 'invalid', 'The widget has no code.');
    if (Buffer.byteLength(json.code, 'utf8') > WIDGET_CODE_MAX) return sendError(res, 413, 'too-large', "A widget's code may be at most 64 KB.");
    const css = json.css ?? '';
    if (typeof css !== 'string') return sendError(res, 400, 'invalid', 'The CSS must be text.');
    if (Buffer.byteLength(css, 'utf8') > WIDGET_CSS_MAX) return sendError(res, 413, 'too-large', "A widget's CSS may be at most 16 KB.");
    let wid = json.id;
    if (wid !== undefined && wid !== null && (typeof wid !== 'string' || !validId(wid))) return sendError(res, 400, 'bad-id', 'Invalid widget id: use 1 to 64 letters, digits, _ or -.');
    if (typeof wid === 'string') {
      if (!existsSync(path.join(dir, `${wid}.json`))) return sendError(res, 404, 'not-found', `No library widget '${wid}'.`);
    } else {
      if (docFiles(dir).length >= WIDGET_MAX_COUNT) return sendError(res, 409, 'full', `The team library holds ${WIDGET_MAX_COUNT} widgets at most. Remove some first.`);
      const stem = widgetId(name);
      wid = stem;
      for (let n = 2; existsSync(path.join(dir, `${wid}.json`)); n++) wid = `${stem}-${n}`;
    }
    const doc = { version: 1, id: wid, name, description: widgetText(json.description, 500), code: json.code, css, by: widgetText(info().user, 64), updated: new Date().toISOString() };
    saveDoc(dir, wid, Buffer.from(JSON.stringify(doc), 'utf8'));
    log('INFO', `Saved library widget ${wid}`);
    return sendJson(res, 200, { ok: true, widget: doc });
  }
  if (!validId(id)) return sendError(res, 400, 'bad-id', 'Invalid widget id: use 1 to 64 letters, digits, _ or -.');
  const file = path.join(dir, `${id}.json`);
  if (req.method === 'GET') return existsSync(file) ? sendJsonText(res, 200, stripBom(readFileSync(file, 'utf8'))) : sendError(res, 404, 'not-found', `No library widget '${id}'.`);
  if (req.method === 'DELETE') {
    if (!removeDoc(dir, id)) return sendError(res, 404, 'not-found', `No library widget '${id}'.`);
    log('INFO', `Moved library widget ${id} to .trash`);
    return sendJson(res, 200, { ok: true });
  }
  return sendError(res, 405, 'method', 'Method not allowed.');
}

function apiRoute(req, res, p, query, json, body) {
  const m = req.method;
  if (p === '/api/commands') return m === 'GET' ? sendJson(res, 200, []) : sendError(res, 405, 'method', 'Method not allowed.');
  if (p === '/api/info') return m === 'GET' ? sendJson(res, 200, info()) : sendError(res, 405, 'method', 'Method not allowed.');
  if (p === '/api/heartbeat') {
    if (m !== 'POST') return sendError(res, 405, 'method', 'Method not allowed.');
    const tab = json && json.tab !== undefined && json.tab !== null ? String(json.tab) : 'default';
    if (!tabOk(tab)) return sendError(res, 400, 'bad-tab', 'Invalid tab id.');
    registerPresence(tab, false);
    return sendJson(res, 200, { ok: true });
  }
  if (p === '/api/end') {
    if (m !== 'POST') return sendError(res, 405, 'method', 'Method not allowed.');
    sendJson(res, 200, { ok: true });
    log('INFO', 'End session requested from the browser');
    return requestStop('end');
  }
  const doc = /^\/api\/(hoists|catalogs|playbook|snapshots|questions|team)(?:\/([^/]*))?$/.exec(p);
  if (doc) return docRoute(req, res, doc[1], p === `/api/${doc[1]}` ? null : (doc[2] ?? ''), query, body);
  if (p === '/api/refresh-report') {
    const file = path.join(docDir('snapshots'), '.last-refresh.json');
    if (m === 'GET') return existsSync(file) ? sendJsonText(res, 200, readFileSync(file, 'utf8')) : sendError(res, 404, 'not-found', 'No refresh has run yet.');
    if (m !== 'POST') return sendError(res, 405, 'method', 'Method not allowed.');
    if (!json) return sendError(res, 400, 'bad-json', 'The body must be a JSON object.');
    const failed = (Array.isArray(json.failed) ? json.failed : []).slice(0, 200).filter((f) => f && typeof f === 'object').map((f) => ({ id: String(f.id ?? '').slice(0, 64), title: String(f.title ?? ''), error: String(f.error ?? '') }));
    const report = { version: 1, at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), by: info().user, computer: 'mock', view, refreshed: Number.parseInt(json.refreshed, 10) || 0, skipped: Number.parseInt(json.skipped, 10) || 0, failed };
    saveDoc(docDir('snapshots'), '.last-refresh', Buffer.from(JSON.stringify(report)));
    return sendJson(res, 200, { ok: true });
  }
  if (p === '/api/query' || p === '/api/profile') {
    if (m !== 'POST') return sendError(res, 405, 'method', 'Method not allowed.');
    if (!json) return sendError(res, 400, 'bad-json', 'The body must be a JSON object.');
    return sendError(res, 404, 'unknown-source', `No source '${String(json.source ?? '')}' on this computer.`);
  }
  if (p === '/api/vault') return m === 'GET' ? sendJson(res, 200, vaultStatus()) : sendError(res, 405, 'method', 'Method not allowed.');
  if (p === '/api/vault/pair') {
    if (m !== 'POST') return sendError(res, 405, 'method', 'Method not allowed.');
    if (typeof json?.code !== 'string' || !/^lztl1\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/.test(json.code)) return sendError(res, 400, 'vault-code', 'That is not a Lazarette pairing code. In Lazarette open Settings > Tools, pair Semaphore and copy the code that starts with lztl1.');
    vaultPaired = true;
    return sendJson(res, 200, vaultStatus());
  }
  if (p === '/api/vault/unpair') {
    if (m !== 'POST') return sendError(res, 405, 'method', 'Method not allowed.');
    vaultPaired = false;
    return sendJson(res, 200, vaultStatus());
  }
  // Spoken answers (Intelligence.ps1): the mock has no TalkForge, so speech answers as the real server does when it is not running.
  if (p === '/api/voice') return m === 'GET' ? sendJson(res, 200, { url: 'http://127.0.0.1:25009', problem: '', tokenSource: 'lazarette', tokenShare: 'TALKFORGE_TOKEN' }) : sendError(res, 405, 'method', 'Method not allowed.');
  if (p === '/api/voice/speak') return m === 'POST' ? sendError(res, 503, 'voice-offline', 'TalkForge is not running at http://127.0.0.1:25009. Start it with talkforge serve, then try again.') : sendError(res, 405, 'method', 'Method not allowed.');
  if (p === '/api/ai') return m === 'GET' ? sendJson(res, 200, aiStatus()) : sendError(res, 405, 'method', 'Method not allowed.');
  // Invoke-SemAiRequest (server/Intelligence.ps1): with no key stored both AI routes answer the same 409.
  if (p === '/api/ai/check' || p === '/api/ai/v1/chat/completions') return m === 'POST' ? sendError(res, 409, 'ai-not-configured', 'No Fairlead client key is stored. Create one in Fairlead > Clients, then run Set-SemaphoreAiKey.bat.') : sendError(res, 405, 'method', 'Method not allowed.');
  const widget = /^\/api\/widgets(?:\/([^/]*))?$/.exec(p);
  if (widget) return widgetRoute(req, res, p === '/api/widgets' ? null : (widget[1] ?? ''), json);
  if (p === '/api/client-log') return clientLogRoute(req, res, json, body);
  return sendError(res, 404, 'not-found', 'Unknown API route.');
}

function handle(req, res, body) {
  if (!originOk(req)) {
    log('WARN', `Refused ${req.method} ${req.url}: not a local same-origin request`);
    return sendError(res, 403, 'forbidden', 'Request refused: not a local same-origin request.');
  }
  const target = req.url ?? '/';
  const qi = target.indexOf('?');
  const p = qi >= 0 ? target.slice(0, qi) : target;
  const query = qi >= 0 ? target.slice(qi + 1) : '';
  if (!/^\/[A-Za-z0-9._~/@+-]*$/.test(p)) return sendError(res, 400, 'bad-path', 'Bad request path.');

  if (p.startsWith('/__mock/')) {
    if (p === '/__mock/launch' && req.method === 'POST') {
      const link = sessionLink();
      return sendJson(res, 200, { code: new URL(link).searchParams.get('launch'), link });
    }
    if (p === '/__mock/state' && req.method === 'GET') {
      const now = Date.now();
      return sendJson(res, 200, { home: homeDir, port, autoStop: presence.autoStop, everSeen: presence.everSeen, liveTabs: liveTabs(now), tabs: [...presence.tabs].map(([tab, t]) => ({ tab, seenAgoMs: now - t.seen, leaving: t.leaving !== null, leavingAgoMs: t.leaving === null ? null : now - t.leaving })), graceMs: presence.graceMs, timeoutMs: presence.timeoutMs, clientLog, saves, vault: { paired: vaultPaired, state: vaultState } });
    }
    if (p === '/__mock/reset' && req.method === 'POST') {
      for (const k of [...KINDS, 'widgets']) {
        rmSync(path.join(homeDir, k), { recursive: true, force: true });
        mkdirSync(path.join(homeDir, k), { recursive: true });
      }
      vaultPaired = false;
      vaultState = vaultDefault;
      clientLog.length = 0;
      clientLogTimes.length = 0;
      saves = 0;
      log('INFO', 'Reset by a test: documents, pairing, client log and counters cleared');
      return sendJson(res, 200, { ok: true });
    }
    if (p === '/__mock/vault' && req.method === 'POST') {
      let state = '';
      try {
        state = String(JSON.parse(body.toString('utf8') || '{}').state ?? '');
      } catch {
        /* refused below */
      }
      if (!VAULT_STATES.includes(state)) return sendError(res, 400, 'invalid', `state must be one of ${VAULT_STATES.join(', ')}.`);
      vaultState = state;
      return sendJson(res, 200, { ok: true, vault: { paired: vaultPaired, state: vaultState } });
    }
    return sendError(res, 404, 'not-found', 'Not found.');
  }
  if (p.startsWith('/__fleethacker/') || p.startsWith('/__semaphore/')) {
    if (p === '/__fleethacker/id') return req.method === 'GET' ? sendJson(res, 200, { tool: 'semaphore', version, pid: process.pid, path: fileURLToPath(import.meta.url), tabs: liveTabs() }) : sendError(res, 405, 'method', 'Method not allowed.');
    if (p === '/__fleethacker/shutdown') {
      if (req.method !== 'POST' || req.headers['x-fleethacker-shutdown'] !== '1') return sendError(res, 405, 'method', 'Method not allowed.');
      send(res, 202, 'application/json; charset=utf-8', '{"stopping":true}');
      return requestStop('shutdown');
    }
    if (p === '/__semaphore/open') {
      if (req.method !== 'POST' || req.headers.origin !== undefined || req.headers['x-semaphore-open'] !== '1') return sendError(res, 405, 'method', 'Method not allowed.');
      send(res, 202, 'application/json; charset=utf-8', '{"opening":true}');
      console.log(`Session link (works once, for 10 minutes): ${sessionLink()}`);
      return;
    }
    return sendError(res, 404, 'not-found', 'Not found.');
  }
  if (p === '/api' || p.startsWith('/api/')) {
    let json = null;
    if (body.length > 0) {
      const text = body.toString('utf8');
      if (!text.trimStart().startsWith('{')) return sendError(res, 400, 'bad-json', 'Request body must be a JSON object.');
      try {
        json = JSON.parse(text);
      } catch {
        return sendError(res, 400, 'bad-json', 'Request body is not valid JSON.');
      }
    }
    if (p === '/api/leaving') {
      if (req.method !== 'POST') return sendError(res, 405, 'method', 'Method not allowed.');
      const tab = json && json.tab !== undefined && json.tab !== null ? String(json.tab) : 'default';
      if (!sameString(json?.token, token)) return sendError(res, 401, 'session', 'Missing or wrong session token.');
      if (!tabOk(tab)) return sendError(res, 400, 'bad-tab', 'Invalid tab id.');
      registerPresence(tab, true);
      return send(res, 204, '', null);
    }
    if (p === '/api/launch') {
      if (req.method !== 'POST') return sendError(res, 405, 'method', 'Method not allowed.');
      if (!useLaunchCode(typeof json?.code === 'string' ? json.code : '')) {
        log('WARN', 'Refused a launch code that was unknown, used or expired');
        return sendError(res, 401, 'launch', 'This launch link has already been used or has expired. Relaunch Semaphore.');
      }
      return sendJson(res, 200, { token });
    }
    if (!sameString(String(req.headers['x-semaphore-session'] ?? ''), token)) return sendError(res, 401, 'session', 'Missing or wrong session token. Relaunch Semaphore.');
    return apiRoute(req, res, p, query, json, body);
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendError(res, 405, 'method', 'Method not allowed.');
  serveStatic(req, res, p);
}

// ---------------------------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------------------------
const server = http.createServer({ headersTimeout: 5000, requestTimeout: 30000, maxHeaderSize: 32768 }, (req, res) => {
  if (req.headers['transfer-encoding']) {
    req.resume();
    return sendError(res, 400, 'bad-request', 'Transfer-Encoding is not supported.');
  }
  const len = Number(req.headers['content-length'] ?? 0);
  if (len > MAX_BODY) {
    req.resume();
    return sendError(res, 413, 'too-large', 'Request body is larger than 8 MB.');
  }
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    try {
      handle(req, res, Buffer.concat(chunks));
    } catch (e) {
      log('ERROR', `${req.method} ${req.url}: ${e.message}`);
      if (!res.headersSent) sendError(res, 500, 'internal', 'Internal server error.');
    }
  });
});

function requestStop(reason) {
  if (stopping) return;
  stopping = true;
  log('INFO', `Stopped (${reason})`);
  // Let the answer that asked for the stop go out first, as the real loop does.
  setTimeout(() => {
    server.close();
    server.closeAllConnections?.();
    if (!keepHome) rmSync(homeDir, { recursive: true, force: true });
    process.exit(0);
  }, 50);
}
process.on('SIGINT', () => requestStop('interrupted'));
process.on('SIGTERM', () => requestStop('terminated'));

server.listen(requestedPort, '127.0.0.1', () => {
  port = server.address().port;
  presence.started = Date.now();
  const how = presence.autoStop ? 'It stops when you close its browser tab or choose End session.' : 'It keeps running after the tab closes: use End session or Stop-Semaphore.ps1.';
  console.log(`Semaphore ${version} is running at http://127.0.0.1:${port}/. ${how}`);
  console.log(`Home: ${homeDir}`);
  console.log(`Session link (works once, for 10 minutes): ${sessionLink()}`);
  setInterval(() => {
    if (!stopping && shouldAutoStop()) {
      log('INFO', 'No Semaphore tab is open any more: stopping');
      requestStop('browser-gone');
    }
  }, msEnv('SEMAPHORE_MOCK_CHECK_MS', 1000)).unref();
});

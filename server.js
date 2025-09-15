/**
 * sync-wall-server: WebSocket + Express server for distributed video wall
 * - Pairing via client-generated 6-digit codes (rotation every 5 minutes)
 * - Admin requests pairing by code; client approves/denies
 * - Unpairing from either side supported (real-time unpair detection)
 * - Sync engine: schedules unified/painting playback at a shared server time
 * - Heartbeat + stale connection cleanup; basic rate limiting
 */
import http from 'http';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { WebSocketServer } from 'ws';
import { RateLimiterMemory } from 'rate-limiter-flexible';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';

const app = express();
const PORT = process.env.PORT || 8080;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim());
const WS_ALLOWED_ORIGINS = (process.env.WS_ALLOWED_ORIGINS || '*').split(',').map(s => s.trim());
const PAIR_RATE_LIMIT_POINTS = parseInt(process.env.PAIR_RATE_LIMIT_POINTS || '10', 10);
const PAIR_RATE_LIMIT_DURATION = parseInt(process.env.PAIR_RATE_LIMIT_DURATION || '2', 10);

// Basic middleware
app.use(helmet());
app.use(express.json());
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error('CORS not allowed'), false);
  }
}));

// REST endpoints
app.get('/health', (req, res) => res.json({ ok: true }));
app.get('/version', (req, res) => res.json({ version: '1.0.0' }));
app.get('/time', (req, res) => res.json({ serverTimeMs: Date.now() }));

const server = http.createServer(app);

// ---- In-memory state ----
/** @type {Map<string, any>} */
const clients = new Map(); // clientId -> { ws, deviceId, code, codeExpiresAt, adminIds:Set, name }
const admins = new Map();  // adminId -> { ws, pairedClientIds:Set, name }
const codeMap = new Map(); // code (string) -> clientId
const pendingPairs = new Map(); // key: `${adminId}:${clientId}` -> { createdAt }

/** For reconnection support by deviceId (not an auth mechanism) */
const deviceIdToClientId = new Map(); // deviceId -> clientId
const deviceIdToAdminId = new Map();  // deviceId -> adminId

// Rate limit pairing attempts (per IP)
const pairLimiter = new RateLimiterMemory({
  points: PAIR_RATE_LIMIT_POINTS,
  duration: PAIR_RATE_LIMIT_DURATION
});

function wsOriginAllowed(origin) {
  if (!origin) return true;
  if (WS_ALLOWED_ORIGINS.includes('*')) return true;
  return WS_ALLOWED_ORIGINS.includes(origin);
}

function now() { return Date.now(); }

function cleanupExpiredCodes() {
  const t = now();
  for (const [code, clientId] of codeMap.entries()) {
    const c = clients.get(clientId);
    if (!c || !c.code || !c.codeExpiresAt || t >= c.codeExpiresAt || c.code !== code) {
      codeMap.delete(code);
    }
  }
}

setInterval(cleanupExpiredCodes, 10_000);

// --- WebSocket setup ---
const wss = new WebSocketServer({ server });

/** heartbeat */
function heartbeat(ws) {
  ws.isAlive = true;
}
wss.on('connection', function connection(ws, req) {
  const origin = req.headers.origin;
  if (!wsOriginAllowed(origin)) {
    ws.close(1008, 'Origin not allowed');
    return;
  }

  ws.id = uuidv4();
  ws.isAlive = true;
  ws.role = null; // 'client' | 'admin'
  ws.meta = { ip: req.socket.remoteAddress };

  ws.on('pong', () => heartbeat(ws));

  ws.on('message', async (data) => {
    let message;
    try {
      message = JSON.parse(data.toString('utf8'));
    } catch (e) {
      return; // ignore invalid
    }
    if (!message || typeof message.type !== 'string') return;

    try {
      switch (message.type) {
        case 'hello':
          // { role: 'client'|'admin', deviceId?: string, name?: string }
          await handleHello(ws, message);
          break;
        case 'registerCode':
          // { code: string, expiresAt: number }
          await handleRegisterCode(ws, message);
          break;
        case 'pairByCode':
          // { code: string, adminName?: string }
          await handlePairByCode(ws, message, req);
          break;
        case 'pairResponse':
          // { adminId: string, accepted: boolean }
          await handlePairResponse(ws, message);
          break;
        case 'unpair':
          // { clientId?: string }
          await handleUnpair(ws, message);
          break;
        case 'syncPlay':
          // { url, mode: 'unified'|'painting', grid?: {rows, cols}, options?: { mute, loop, startDelayMs } }
          await handleSyncPlay(ws, message);
          break;
        case 'syncStop':
          await handleSyncStop(ws, message);
          break;
        case 'timeSync':
          wsSend(ws, { type: 'timeSyncAck', t: message.t, serverTimeMs: now() });
          break;
        default:
          // ignore unknown
          break;
      }
    } catch (err) {
      wsSend(ws, { type: 'error', message: err?.message || 'Server error' });
    }
  });

  ws.on('close', () => {
    handleDisconnect(ws);
  });
});

// ping clients every 20s
const interval = setInterval(function ping() {
  wss.clients.forEach(function each(ws) {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  });
}, 20_000);

wss.on('close', function close() {
  clearInterval(interval);
});

// ---- Handlers ----
async function handleHello(ws, msg) {
  const { role, deviceId, name } = msg;
  if (role !== 'client' && role !== 'admin') {
    wsSend(ws, { type: 'error', message: 'Invalid role' });
    return;
  }
  ws.role = role;
  ws.name = typeof name === 'string' ? name.slice(0, 64) : undefined;

  if (role === 'client') {
    let clientId = deviceIdToClientId.get(deviceId || '');
    if (!clientId) clientId = uuidv4();

    // Bind/replace existing
    const existing = clients.get(clientId);
    if (existing && existing.ws && existing.ws !== ws) {
      try { existing.ws.close(1000, 'Reconnected'); } catch {}
    }
    clients.set(clientId, {
      ws, deviceId: deviceId || null, code: null, codeExpiresAt: 0,
      adminIds: new Set(), name: ws.name || null, lastSeen: now()
    });
    if (deviceId) deviceIdToClientId.set(deviceId, clientId);

    ws.clientId = clientId;
    wsSend(ws, { type: 'helloAck', role, clientId, serverTimeMs: now(), version: '1.0.0' });

  } else if (role === 'admin') {
    let adminId = deviceIdToAdminId.get(deviceId || '');
    if (!adminId) adminId = uuidv4();

    const existing = admins.get(adminId);
    if (existing && existing.ws && existing.ws !== ws) {
      try { existing.ws.close(1000, 'Reconnected'); } catch {}
    }
    admins.set(adminId, { ws, pairedClientIds: existing?.pairedClientIds || new Set(), name: ws.name || null });
    if (deviceId) deviceIdToAdminId.set(deviceId, adminId);

    ws.adminId = adminId;
    // Rehydrate: notify admin of currently paired clients if any
    const paired = Array.from(admins.get(adminId).pairedClientIds || []);
    wsSend(ws, { type: 'helloAck', role, adminId, paired, serverTimeMs: now(), version: '1.0.0' });
  }
}

function isSixDigit(code) {
  return typeof code === 'string' && /^\d{6}$/.test(code);
}

async function handleRegisterCode(ws, msg) {
  if (ws.role !== 'client' || !ws.clientId) return;
  const { code, expiresAt } = msg;
  if (!isSixDigit(code)) throw new Error('Invalid code');
  const exp = Number(expiresAt);
  const t = now();
  if (!Number.isFinite(exp) || exp <= t || exp - t > 10 * 60 * 1000) throw new Error('Invalid expiresAt');

  // Check if code used by another client
  const existingClientId = codeMap.get(code);
  if (existingClientId && existingClientId !== ws.clientId) {
    wsSend(ws, { type: 'codeRejected', reason: 'inUse' });
    return;
  }
  // Remove old code if any
  const c = clients.get(ws.clientId);
  if (c && c.code && c.code !== code) {
    codeMap.delete(c.code);
  }
  // Save
  codeMap.set(code, ws.clientId);
  c.code = code;
  c.codeExpiresAt = exp;
  wsSend(ws, { type: 'codeRegistered', code, expiresAt: exp });
}

async function handlePairByCode(ws, msg, req) {
  if (ws.role !== 'admin' || !ws.adminId) return;

  // Rate-limit per IP (best-effort if IP absent)
  const ip = ws.meta?.ip || req.socket.remoteAddress || 'unknown';
  try {
    await pairLimiter.consume(ip);
  } catch {
    wsSend(ws, { type: 'rateLimited', message: 'Too many pair attempts' });
    return;
  }

  const { code } = msg;
  if (!isSixDigit(code)) {
    wsSend(ws, { type: 'pairError', message: 'Invalid code' });
    return;
  }
  const clientId = codeMap.get(code);
  if (!clientId) {
    wsSend(ws, { type: 'pairError', message: 'Code not found or expired' });
    return;
  }
  const c = clients.get(clientId);
  if (!c || !c.ws) {
    wsSend(ws, { type: 'pairError', message: 'Client offline' });
    return;
  }
  if (now() >= (c.codeExpiresAt || 0)) {
    wsSend(ws, { type: 'pairError', message: 'Code expired' });
    return;
  }
  const key = `${ws.adminId}:${clientId}`;
  pendingPairs.set(key, { createdAt: now() });
  // Send request to client to approve
  wsSend(c.ws, { type: 'pairRequest', adminId: ws.adminId, adminName: ws.name || 'Admin' });
  wsSend(ws, { type: 'pairPending', clientId });
}

async function handlePairResponse(ws, msg) {
  if (ws.role !== 'client' || !ws.clientId) return;
  const { adminId, accepted } = msg || {};
  const key = `${adminId}:${ws.clientId}`;
  if (!pendingPairs.has(key)) return; // stale

  const a = admins.get(adminId);
  pendingPairs.delete(key);

  if (!accepted) {
    if (a?.ws) wsSend(a.ws, { type: 'pairDenied', clientId: ws.clientId });
    return;
  }
  // Establish pair
  const cState = clients.get(ws.clientId);
  cState.adminIds.add(adminId);
  const aState = admins.get(adminId) || { ws: null, pairedClientIds: new Set() };
  aState.pairedClientIds.add(ws.clientId);
  admins.set(adminId, aState);

  wsSend(ws, { type: 'paired', adminId });
  if (a?.ws) wsSend(a.ws, { type: 'paired', clientId: ws.clientId });
}

async function handleUnpair(ws, msg) {
  if (ws.role === 'admin' && ws.adminId) {
    const { clientId } = msg || {};
    const aState = admins.get(ws.adminId);
    if (!aState) return;
    const targets = clientId ? [clientId] : Array.from(aState.pairedClientIds);
    for (const cid of targets) {
      aState.pairedClientIds.delete(cid);
      const cState = clients.get(cid);
      if (cState) {
        cState.adminIds.delete(ws.adminId);
        if (cState.ws) wsSend(cState.ws, { type: 'unpaired', adminId: ws.adminId, reason: 'admin' });
      }
      wsSend(ws, { type: 'unpairedAck', clientId: cid });
    }
  } else if (ws.role === 'client' && ws.clientId) {
    // Client unpairs from all admins
    const cState = clients.get(ws.clientId);
    if (!cState) return;
    for (const adminId of Array.from(cState.adminIds)) {
      const aState = admins.get(adminId);
      if (aState) aState.pairedClientIds.delete(ws.clientId);
      const aWs = aState?.ws;
      if (aWs) wsSend(aWs, { type: 'unpaired', clientId: ws.clientId, reason: 'client' });
      cState.adminIds.delete(adminId);
    }
    wsSend(ws, { type: 'unpairedAck', all: true });
  }
}

function computeAssignmentsForAdmin(adminId) {
  const aState = admins.get(adminId);
  if (!aState) return [];
  return Array.from(aState.pairedClientIds);
}

async function handleSyncPlay(ws, msg) {
  if (ws.role !== 'admin' || !ws.adminId) return;
  const { url, mode, grid, options } = msg || {};
  if (!url || typeof url !== 'string') throw new Error('Missing url');
  if (mode !== 'unified' && mode !== 'painting') throw new Error('Invalid mode');

  const rows = Math.max(1, parseInt(grid?.rows || '1', 10));
  const cols = Math.max(1, parseInt(grid?.cols || '1', 10));
  const startDelayMs = Math.min(Math.max(parseInt(options?.startDelayMs || '3000', 10), 1000), 10000);

  const assigned = computeAssignmentsForAdmin(ws.adminId);
  const startAtMs = now() + startDelayMs;

  let index = 0;
  for (const clientId of assigned) {
    const cState = clients.get(clientId);
    if (!cState?.ws) continue;
    const tileIndex = index++;
    wsSend(cState.ws, {
      type: 'syncPrepare',
      url,
      mode,
      grid: { rows, cols },
      tileIndex,
      startAtMs,
      options: {
        mute: !!options?.mute,
        loop: !!options?.loop
      }
    });
  }
  wsSend(ws, { type: 'syncScheduled', startAtMs, count: assigned.length });
}

async function handleSyncStop(ws, msg) {
  if (ws.role !== 'admin' || !ws.adminId) return;
  const assigned = computeAssignmentsForAdmin(ws.adminId);
  for (const clientId of assigned) {
    const cState = clients.get(clientId);
    if (!cState?.ws) continue;
    wsSend(cState.ws, { type: 'syncStop' });
  }
  wsSend(ws, { type: 'syncStopped', count: assigned.length });
}

function handleDisconnect(ws) {
  if (ws.role === 'client' && ws.clientId) {
    const c = clients.get(ws.clientId);
    if (c) {
      c.ws = null;
      c.lastSeen = now();
      // Keep pairing state for a while (transient network blips)
    }
  } else if (ws.role === 'admin' && ws.adminId) {
    const a = admins.get(ws.adminId);
    if (a) {
      a.ws = null;
      // keep pairs (client remains paired but will not receive admin commands until admin reconnects)
    }
  }
}

function wsSend(ws, obj) {
  if (!ws || ws.readyState !== 1) return;
  try { ws.send(JSON.stringify(obj)); } catch {}
}

server.listen(PORT, () => {
  console.log(`sync-wall-server listening on :${PORT}`);
});

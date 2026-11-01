// Shared HTTPS client with persistent keep-alive connections for Groq and ElevenLabs.
// Why: Node's built-in fetch drops idle connections after ~4s, and turns are further apart than
// that, so every suggestion/TTS request paid a fresh DNS + TLS handshake (measured: TTS first byte
// 645-1347ms on new connections, 7.3s on a cold first one, vs 220-520ms on a reused socket).
// Never logs URLs with secrets, headers, or bodies.
const https = require('https');

const agent = new https.Agent({ keepAlive: true, keepAliveMsecs: 15000, maxSockets: 16 });
// Some providers drop idle keep-alive sockets after a few seconds, so warm a host once it has
// been idle this long (never while a real request is using it).
const WARM_IF_IDLE_MS = 4000;
const lastUsed = new Map(); // host -> ms timestamp of last request start/end
const inflight = new Map(); // host -> active request count

// Returns the IncomingMessage (async-iterable body). Rejects on network error, abort or timeout.
function request(url, { method = 'GET', headers = {}, body, signal, timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    const signals = [signal, timeoutMs ? AbortSignal.timeout(timeoutMs) : null].filter(Boolean);
    const combined = signals.length ? AbortSignal.any(signals) : undefined;
    const host = new URL(url).host;
    const started = performance.now();
    lastUsed.set(host, Date.now());
    inflight.set(host, (inflight.get(host) || 0) + 1);
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      inflight.set(host, inflight.get(host) - 1);
      lastUsed.set(host, Date.now());
    };
    const req = https.request(url, { method, headers, agent, signal: combined }, (res) => {
      res.on('close', finish);
      if (process.env.REFRAME_DEBUG_NET) console.log(`[net] ${host} ${method} reused=${req.reusedSocket} headers ${Math.round(performance.now() - started)}ms`);
      resolve(res);
    });
    req.on('error', (err) => {
      finish();
      if (timeoutMs && combined && combined.aborted && !(signal && signal.aborted)) {
        const e = new Error('timeout');
        e.code = 'TIMEOUT';
        return reject(e);
      }
      reject(err);
    });
    req.end(body);
  });
}

async function readBody(res) {
  const chunks = [];
  for await (const c of res) chunks.push(c);
  return Buffer.concat(chunks).toString();
}

// Cheap authenticated GET that opens (or keeps open) a pooled TLS connection.
// sockets > 1 opens that many parallel connections (Groq uses 2 so a hedged request has one ready).
async function warm(url, headers, sockets = 1) {
  const host = new URL(url).host;
  if (inflight.get(host) > 0 || Date.now() - (lastUsed.get(host) || 0) < WARM_IF_IDLE_MS) return;
  await Promise.all(Array.from({ length: sockets }, async () => {
    try {
      const res = await request(url, { headers, timeoutMs: 5000 });
      res.resume();
    } catch {
      // warm-up is best effort
    }
  }));
}

module.exports = { request, readBody, warm };

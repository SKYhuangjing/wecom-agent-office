// Kernel HTTP shell: prefix router + failure-isolation wrapper + SSE backbone (spec §2.1/§8).
// Plugin handlers are untrusted code: every dispatch is wrapped so a plugin's
// throw becomes an attributed 500 (or a socket kill once headers are out)
// instead of an unhandled error that takes the process down. Body parsing is
// deliberately absent — plugins parse their own bodies.
import { createServer } from 'node:http';

const HEARTBEAT_MS = 15_000;
// Kernel built-ins: shadowing them with a plugin handler would be a silent
// trap (dispatch checks them first), so registration refuses outright.
const RESERVED = new Set(['/healthz', '/api/events']);

export function createHttpShell({ log }) {
  const routes = new Map(); // prefix -> { handler, owner }
  const sse = new Set(); // live client records { res, close }; Set delete is idempotent
  const startedAt = Date.now(); // /healthz uptime base
  let server = null;

  const json = (res, code, obj, extra = {}) => {
    res.writeHead(code, { 'Content-Type': 'application/json', ...extra });
    res.end(JSON.stringify(obj));
  };

  const startSse = (res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    res.flushHeaders?.(); // headers must reach the client before any event, else fetch hangs pre-frame
    const client = { res, close: null };
    let hb = null;
    const drop = () => { if (hb) clearInterval(hb); sse.delete(client); };
    client.close = drop;
    // Comment frame: keeps the link warm through intermediaries; EventSource ignores it.
    hb = setInterval(() => { try { res.write(': ka\n\n'); } catch { drop(); } }, HEARTBEAT_MS);
    hb.unref?.(); // heartbeats must never hold the process open (also tolerates test timer mocks)
    res.on('error', drop); // dead socket surfaces as a stream error, not a sync throw
    res.on('close', drop); // client disconnect = the normal end of an SSE connection
    sse.add(client);
  };

  const handle = (req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname; // base makes relative req.url well-formed
    if (pathname === '/healthz') {
      if (req.method === 'GET') return json(res, 200, { ok: true, pid: process.pid, uptimeSec: Math.round((Date.now() - startedAt) / 1000) });
    }
    if (pathname === '/api/events') {
      if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' }, { Allow: 'GET' });
      return startSse(res);
    }
    // Longest matching prefix wins: /api and /api/dsh can coexist, the more specific one serving deeper paths.
    let best = null;
    for (const [prefix, route] of routes) {
      if (pathname.startsWith(prefix) && (!best || prefix.length > best.prefix.length)) best = { prefix, route };
    }
    if (!best) return json(res, 404, { error: 'not found' });
    // One attribution path for both failure timings. A rejected thenable lands
    // here on a later tick, so the response-state guards must be re-checked
    // then: the handler may already have fully responded (log-only) or already
    // have headers out (destroy the socket, never double-respond).
    const fail = (err) => {
      log.error(`http: ${best.route.owner} handler failed`, `${req.method} ${pathname}`, err);
      if (res.writableEnded) return; // full response already went out: logging is the whole remedy
      if (res.headersSent) res.destroy();
      else json(res, 500, { error: err?.message ?? String(err) });
    };
    try {
      const result = best.route.handler(req, res);
      // Async handler: the sync try/catch above cannot see its rejection —
      // without this, one rejected plugin promise kills the whole kernel.
      if (result && typeof result.catch === 'function') result.catch(fail);
    } catch (err) {
      fail(err);
    }
  };

  return {
    register({ prefix, handler, owner }) {
      if (typeof prefix !== 'string' || !prefix.startsWith('/')) throw new Error(`http: prefix must start with '/': ${String(prefix)}`);
      if (RESERVED.has(prefix)) throw new Error(`http: prefix reserved by the kernel: ${prefix}`);
      if (routes.has(prefix)) throw new Error(`http: prefix already registered: ${prefix}`);
      routes.set(prefix, { handler, owner });
    },
    handle,
    sseSend(event, data) {
      const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      for (const c of sse) { // deleting the current entry mid-iteration is safe on a Set
        const { res } = c;
        if (res.destroyed || res.writableEnded) { c.close(); continue; } // stale entry: drop, don't throw
        try { res.write(frame); } catch { c.close(); } // write-after-finish: lose one client, not the broadcast
      }
    },
    sseClients: () => sse.size,
    listen(port, host) {
      if (!server) server = createServer(handle); // tests may instead wrap handle in their own server
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          // Post-listen socket errors must be logged, not crash the kernel as unhandled 'error'.
          server.on('error', (err) => log.error('http: server error', err));
          resolve();
        });
      });
    },
    close() {
      for (const c of sse) { try { c.res.end(); } catch {} } // open SSE streams would pin server.close() forever
      sse.clear();
      if (!server) return Promise.resolve(); // never listened: nothing to close
      return new Promise((resolve) => {
        server.closeIdleConnections?.(); // undici's fetch agent parks idle keep-alive sockets
        server.close(() => resolve()); // closing a non-listening server still calls back; that is fine here
      });
    },
    get port() { return server?.listening ? server.address().port : null; },
  };
}

// MCP gateway server (W1 T1): the minimal Model Context Protocol subset the
// company exposes to AI Agent CLIs — JSON-RPC 2.0 over POST /mcp (the
// streamable-HTTP transport without its SSE half). Scope is the protocol
// floor: initialize handshake + session header, tools/list, tools/call
// (surface wired in T2) and fire-and-forget notifications. GET /mcp (server
// push over SSE) is a phase-2 concern and answers 405 with an explanation.
//
// Error-channel rule (why this file never rejects to the kernel shell): the
// shell turns a rejected handler into an attributed HTTP 500 with its own
// REST error shape — right for /api routes, wrong for JSON-RPC, where every
// protocol-level failure must surface as HTTP 200 + {error:{code,...}}.
// Transport-level failures (wrong method/media type/oversized body) keep
// HTTP status codes: those are HTTP problems, not protocol ones.
import { randomUUID } from 'node:crypto';

// The one revision this subset speaks. A client asking for anything else
// gets this value back in initialize and decides to continue or disconnect.
export const PROTOCOL_VERSION = '2025-06-18';

const SERVER_NAME = 'wao-company';
// Tool-call arguments carry whole prompts, larger than core-engine's
// UI-facing 64KB API bodies — but still bounded, so a runaway client cannot
// buffer unbounded memory.
const BODY_LIMIT_BYTES = 256 * 1024;

// JSON-RPC 2.0 reserved codes + the MCP server-defined session code.
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;
const SESSION_REQUIRED = -32002;

// Shape a request/notification frame must have for BOTH kinds to be valid:
// jsonrpc 2.0 + non-empty string method; `id` decides the kind (absent =
// notification, string/number/null = request); params, when present, must be
// structured (object/array) per JSON-RPC. Returns null when valid.
function frameError(msg) {
  if (msg == null || typeof msg !== 'object' || Array.isArray(msg)) return 'message must be a JSON object';
  if (msg.jsonrpc !== '2.0') return "jsonrpc must be '2.0'";
  if (typeof msg.method !== 'string' || msg.method === '') return 'method must be a non-empty string';
  if (msg.id !== undefined && !(typeof msg.id === 'string' || typeof msg.id === 'number' || msg.id === null)) {
    return 'id must be a string, number or null';
  }
  if (msg.params !== undefined && (msg.params === null || typeof msg.params !== 'object')) {
    return 'params must be an object or array';
  }
  return null;
}

// Bounded body read — the shell parses nothing (http.js contract).
// Rejects with a plain {status, message} transport error; the single catch
// in the dispatch wrapper is the only place that reads it.
const readBody = (req) => new Promise((resolve, reject) => {
  const chunks = [];
  let size = 0;
  let over = false;
  req.on('data', (chunk) => {
    if (over) return; // already rejected: drain quietly, never buffer more
    size += chunk.length;
    if (size > BODY_LIMIT_BYTES) {
      over = true;
      chunks.length = 0;
      reject({ status: 413, message: `request body exceeds ${BODY_LIMIT_BYTES} bytes` });
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => { if (!over) resolve(Buffer.concat(chunks).toString('utf8')); });
  req.on('error', (err) => { if (!over) reject({ status: 400, message: `request stream error: ${err?.message ?? err}` }); });
});

// Build the /mcp request handler. `listTools`/`callTool` are the T2 seam:
// T1 ships the protocol shell with an empty roster and no call impl
// (tools/call answers -32601 until the tool surface lands).
// Returns { handler, sessionCount } — sessionCount is the console's AI-access
// discovery probe (/api/mcp in plugin.js reads it to show "N 个 AI 会话活跃").
export function createMcpHandler({ version, listTools = () => [], callTool = null, log = null }) {
  // Live Mcp-Session-Id set. Single-user office: no TTL — the ONLY way a
  // session ends is an explicit DELETE /mcp (or a server restart, which a
  // stale client recovers from via the -32002 → re-initialize path).
  const liveSessions = new Set();

  const httpJson = (res, code, obj, extra = {}) => {
    res.writeHead(code, { 'Content-Type': 'application/json', ...extra });
    res.end(JSON.stringify(obj));
  };
  const rpcResult = (res, id, result, extra = {}) => {
    res.writeHead(200, { 'Content-Type': 'application/json', ...extra });
    res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
  };
  const rpcError = (res, id, code, message, extra = {}) => {
    res.writeHead(200, { 'Content-Type': 'application/json', ...extra });
    res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }));
  };

  const onPost = async (req, res) => {
    // Media type check: compare the type before any ';' parameter,
    // case-insensitively — 'application/json; charset=utf-8' is fine.
    const media = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (media !== 'application/json') {
      return httpJson(res, 415, { error: `unsupported content type ${media || '(none)'}: POST /mcp requires application/json` });
    }
    let text;
    try { text = await readBody(req); } catch (err) {
      return httpJson(res, err.status, { error: err.message }); // transport-level → HTTP status
    }
    let msg;
    try { msg = JSON.parse(text); } catch {
      // Empty body lands here too: '' is not valid JSON, and -32700 is the
      // honest code for it (there is no id to echo).
      return rpcError(res, null, PARSE_ERROR, 'parse error: request body is not valid JSON');
    }

    if (Array.isArray(msg)) {
      // JSON-RPC batching was removed from MCP in 2025-06-18; the one array
      // shape this subset keeps is a pure NOTIFICATION batch — it has no
      // response to compose, so accepting it costs nothing and keeps chatty
      // clients working. An array carrying a request (any id present) or any
      // malformed item is -32600: we do not answer batches.
      if (msg.length === 0) return rpcError(res, null, INVALID_REQUEST, 'invalid request: empty batch');
      for (const item of msg) {
        const why = frameError(item);
        if (why != null) return rpcError(res, null, INVALID_REQUEST, `invalid request: batch item: ${why}`);
        if (item.id !== undefined) return rpcError(res, null, INVALID_REQUEST, 'invalid request: batched requests are not supported (notification batches only)');
      }
      res.writeHead(202);
      res.end();
      return;
    }

    const why = frameError(msg);
    if (why != null) return rpcError(res, null, INVALID_REQUEST, `invalid request: ${why}`);

    // Notifications (no id) NEVER get a JSON-RPC reply — not even an error —
    // so session gating cannot apply to them; 202 is the whole contract.
    if (msg.id === undefined) {
      res.writeHead(202);
      res.end();
      return;
    }

    // Requests need a live session, except initialize — it MINTS one.
    const sessionId = req.headers['mcp-session-id'];
    if (msg.method !== 'initialize') {
      if (typeof sessionId !== 'string' || sessionId === '') {
        return rpcError(res, msg.id, SESSION_REQUIRED, 'session required: send initialize first and include its Mcp-Session-Id header');
      }
      if (!liveSessions.has(sessionId)) {
        return rpcError(res, msg.id, SESSION_REQUIRED, 'unknown or terminated Mcp-Session-Id: re-initialize');
      }
    }

    try {
      if (msg.method === 'initialize') {
        const newId = randomUUID();
        liveSessions.add(newId);
        log?.debug?.(`mcp: session ${newId} initialized`);
        // Version negotiation: echo the client's version when we speak it,
        // otherwise answer with ours — the client then decides whether to
        // continue (the spec lets either side disconnect on mismatch).
        const requested = msg.params?.protocolVersion;
        return rpcResult(res, msg.id, {
          protocolVersion: requested === PROTOCOL_VERSION ? requested : PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version },
        }, { 'Mcp-Session-Id': newId });
      }
      const echo = { 'Mcp-Session-Id': sessionId }; // session carried → echoed back
      if (msg.method === 'tools/list') {
        return rpcResult(res, msg.id, { tools: listTools() }, echo);
      }
      if (msg.method === 'tools/call') {
        if (callTool == null) return rpcError(res, msg.id, METHOD_NOT_FOUND, 'tools/call is not implemented yet (tool surface arrives with T2)');
        let result;
        try {
          result = await callTool(msg.params ?? {});
        } catch (err) {
          // Tool-LAYER protocol failures (unknown tool name, unshaped params)
          // carry their own JSON-RPC code; everything else stays the generic
          // internal error. Business failures never land here — the tool
          // surface reports those as isError results so Agents can read them.
          if (Number.isInteger(err?.jsonRpcCode)) {
            return rpcError(res, msg.id, err.jsonRpcCode, err?.message ?? 'invalid params', echo);
          }
          throw err;
        }
        return rpcResult(res, msg.id, result, echo);
      }
      return rpcError(res, msg.id, METHOD_NOT_FOUND, `unknown method: ${msg.method}`);
    } catch (err) {
      // Handler-body failure stays inside the protocol: -32603 over HTTP 200,
      // never a shell-attributed 500.
      log?.error?.(`mcp: dispatch failed for ${msg.method}: ${err?.message ?? err}`);
      return rpcError(res, msg.id, INTERNAL_ERROR, 'internal error');
    }
  };

  const dispatch = async (req, res) => {
    // Prefix bleed guard: the shell matches by startsWith, so /mcpfoo also
    // routes here — anything that is not /mcp (or its trailing-slash twin)
    // gets the kernel's 404 shape.
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname !== '/mcp' && pathname !== '/mcp/') return httpJson(res, 404, { error: 'not found' });

    if (req.method === 'POST') return onPost(req, res);

    if (req.method === 'GET') {
      req.resume(); // drain any (unexpected) body so keep-alive sockets stay reusable
      return httpJson(res, 405, {
        error: 'method not allowed',
        message: 'GET /mcp（SSE 服务端推送）为二期能力；当前请用 POST /mcp 发送 JSON-RPC 2.0 请求',
      }, { Allow: 'POST, DELETE' });
    }
    if (req.method === 'DELETE') {
      req.resume();
      const sessionId = req.headers['mcp-session-id'];
      if (typeof sessionId === 'string' && sessionId !== '' && liveSessions.delete(sessionId)) {
        log?.debug?.(`mcp: session ${sessionId} terminated`);
      } // unknown/absent id: idempotent no-op — DELETE is always 202
      res.writeHead(202);
      res.end();
      return;
    }
    req.resume();
    return httpJson(res, 405, { error: 'method not allowed' }, { Allow: 'POST, DELETE' });
  };

  // Sole entry the kernel shell sees. The catch is ours, not the shell's:
  // a JSON-RPC client must never receive the shell's REST 500 shape.
  return {
    handler: (req, res) => {
      dispatch(req, res).catch((err) => {
        log?.error?.(`mcp: handler failed: ${err?.message ?? err}`);
        if (res.writableEnded) return;
        if (res.headersSent) { res.destroy?.(); return; }
        httpJson(res, 500, { error: 'mcp gateway failure' });
      });
    },
    sessionCount: () => liveSessions.size,
  };
}

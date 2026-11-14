// app.ts — HTTP server for the forge: routing, auth, body handling, responses.
// Plain JavaScript syntax in a .ts file (runs under --experimental-strip-types).
import http from 'node:http';
import { Store } from './store.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import {
  advertiseV2, advertiseV0, handleLsRefsV2, handleFetchV2, handleFetchV0,
  handleReceivePack,
} from './gitproto.ts';
import { decodePktLines } from './gitutil.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

let requestCounter = 0;

function expectedToken() {
  return process.env.MAKEFUN_SHOP_TOKEN || '';
}

// Auth: exact match when MAKEFUN_SHOP_TOKEN is set; any non-empty Bearer token
// when unset (local testing). Missing/wrong token -> 401 JSON.
function checkAuth(req) {
  const expected = expectedToken();
  const header = req.headers.authorization || '';
  const m = /^Bearer (.+)$/.exec(header);
  if (!m) return false;
  if (expected === '') return m[1].length > 0;
  return m[1] === expected;
}

function sendJson(res, status, obj, extraHeaders) {
  const body = obj === null ? '' : JSON.stringify(obj);
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'X-GitHub-Request-Id': `req-${++requestCounter}`,
    ...extraHeaders,
  };
  res.writeHead(status, headers);
  res.end(body);
}

function sendBytes(res, status, buf, contentType, extraHeaders) {
  const headers = {
    'Content-Type': contentType,
    'Content-Length': buf.length,
    'X-GitHub-Request-Id': `req-${++requestCounter}`,
    ...extraHeaders,
  };
  res.writeHead(status, headers);
  res.end(buf);
}

function sendNoContent(res, status) {
  res.writeHead(status, {
    'X-GitHub-Request-Id': `req-${++requestCounter}`,
  });
  res.end();
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function createApp() {
  const store = new Store();
  const server = http.createServer((req, res) => {
    handleRequest(store, req, res).catch((e) => {
      if (!res.headersSent) {
        sendJson(res, 500, { message: String(e.message || 'Internal Server Error') });
      } else {
        res.end();
      }
    });
  });
  return server;
}

async function handleRequest(store, req, res) {
  const url = new URL(req.url || '/', 'http://localhost');
  const pathname = url.pathname;
  const query = url.searchParams;
  const method = req.method || 'GET';
  const baseUrl = `http://${req.headers.host || 'localhost'}`;
  const segs = pathname.split('/').filter((s) => s.length > 0).map((s) => {
    try { return decodeURIComponent(s); } catch { return s; }
  });

  // /healthz — no auth, called twice at boot.
  if (pathname === '/healthz') {
    if (method === 'GET') return sendJson(res, 200, { ok: true });
    return sendJson(res, 404, { message: 'Not Found' });
  }

  // Auth for everything below (except the public REST root/meta).
  const isPublicRest = pathname === '/api/v3' || pathname === '/api/v3/'
    || pathname === '/api/v3/meta';
  if (!isPublicRest && !checkAuth(req)) {
    return sendJson(res, 401, { message: 'Requires authentication' });
  }

  // Git smart HTTP: /{owner}/{repo}.git/...
  if (segs.length >= 3 && segs[1].endsWith('.git')) {
    return handleGit(store, req, res, segs, query, method, baseUrl);
  }

  // GraphQL
  if (pathname === '/api/graphql' && method === 'POST') {
    const body = await readBody(req);
    const out = handleGraphQL(store, body.toString('utf8'));
    return sendJson(res, out.status, out.body);
  }

  // MCP
  if (pathname === '/mcp') {
    if (method === 'POST') {
      const body = await readBody(req);
      const headers = {
        'mcp-protocol-version': req.headers['mcp-protocol-version'],
      };
      const out = handleMcp(store, body.toString('utf8'), headers);
      if (out.body === null) {
        res.writeHead(out.status, { 'Content-Length': 0 });
        return res.end();
      }
      return sendJson(res, out.status, out.body);
    }
    if (method === 'DELETE') {
      return sendJson(res, 405, { message: 'No session' });
    }
    return sendJson(res, 405, { message: 'Method Not Allowed' });
  }

  // REST v3
  if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
    const bodyBuf = (method === 'GET' || method === 'HEAD')
      ? Buffer.alloc(0)
      : await readBody(req);
    return handleRestRoute(store, req, res, segs, query, method, bodyBuf, baseUrl);
  }

  return sendJson(res, 404, { message: 'Not Found' });
}

async function handleRestRoute(store, req, res, segs, query, method, bodyBuf, baseUrl) {
  // segs[0] is 'api', segs[1] is 'v3'; the REST handler takes the rest.
  const restSegs = segs.slice(2);
  let body = null;
  let bodyMalformed = false;
  if (bodyBuf.length > 0) {
    try {
      body = JSON.parse(bodyBuf.toString('utf8'));
    } catch {
      bodyMalformed = true;
    }
  }
  const ctx = {
    store,
    method,
    segs: restSegs,
    query,
    body,
    bodyMalformed,
    baseUrl,
    json: (status, obj, extraHeaders) => sendJson(res, status, obj, extraHeaders),
    noContent: (status) => sendNoContent(res, status),
    error: (status, message) => sendJson(res, status, { message }),
  };
  return handleRest(ctx);
}

async function handleGit(store, req, res, segs, query, method, baseUrl) {
  const owner = segs[0];
  const repoName = segs[1].slice(0, -4);
  const repo = store.getRepo(owner, repoName);
  const service = segs[2];
  const sub = segs[3];

  // info/refs
  if (service === 'info' && sub === 'refs' && method === 'GET') {
    const svc = query.get('service') || '';
    if (!repo) return sendJson(res, 404, { message: 'Not Found' });
    if (svc === 'git-upload-pack') {
      const isV2 = (req.headers['git-protocol'] || '') === 'version=2';
      const body = isV2 ? advertiseV2() : advertiseV0(repo, 'upload-pack');
      return sendBytes(res, 200, body, 'application/x-git-upload-pack-advertisement');
    }
    if (svc === 'git-receive-pack') {
      const body = advertiseV0(repo, 'receive-pack');
      return sendBytes(res, 200, body, 'application/x-git-receive-pack-advertisement');
    }
    return sendJson(res, 400, { message: 'unknown service' });
  }

  // git-upload-pack POST
  if (service === 'git-upload-pack' && method === 'POST') {
    if (!repo) return sendJson(res, 404, { message: 'Not Found' });
    const body = await readBody(req);
    try {
      const isV2 = (req.headers['git-protocol'] || '') === 'version=2';
      let out;
      if (isV2) {
        // First pkt-line decides: command=ls-refs or command=fetch.
        const packets = decodePktLines(body);
        const first = packets.find((p) => p.kind === 'data');
        const cmd = first ? first.payload.toString('utf8') : '';
        if (cmd.startsWith('command=ls-refs')) out = handleLsRefsV2(repo, body);
        else if (cmd.startsWith('command=fetch')) out = handleFetchV2(store, repo, body);
        else return sendJson(res, 400, { message: 'unknown v2 command' });
      } else {
        out = handleFetchV0(store, repo, body);
      }
      return sendBytes(res, 200, out, 'application/x-git-upload-pack-result');
    } catch (e) {
      // Malformed POST body: answer (any status) and stay healthy.
      return sendJson(res, 400, { message: String(e.message || 'malformed request') });
    }
  }

  // git-receive-pack POST
  if (service === 'git-receive-pack' && method === 'POST') {
    if (!repo) return sendJson(res, 404, { message: 'Not Found' });
    const body = await readBody(req);
    const out = handleReceivePack(store, repo, body);
    return sendBytes(res, out.status, out.body, out.contentType || 'application/x-git-receive-pack-result');
  }

  return sendJson(res, 404, { message: 'Not Found' });
}
